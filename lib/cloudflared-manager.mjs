import { spawn, execSync } from 'node:child_process';
import { createWriteStream, createReadStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { chmod, stat, unlink, rename } from 'node:fs/promises';
import { homedir, platform, arch } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { get as httpsGet } from 'node:https';

const CLOUDFLARED_VERSION = '2024.10.0';
const DOWNLOAD_TIMEOUT = 5 * 60 * 1000; // 5 分钟
const MIN_BINARY_SIZE = 5 * 1024 * 1024; // 最小 5MB，防止下到 HTML 错误页
const HANDSHAKE_TIMEOUT_MS = 90 * 1000; // 等待隧道就绪的握手超时（默认 90s，可注入）
const RETRY_BASE_MS = 5 * 1000; // 自愈退避起点 5s
const RETRY_MAX_MS = 5 * 60 * 1000; // 自愈退避封顶 5min
const DEFAULT_MAX_RETRIES = 12; // 连续失败超过该次数转为 error，不再无限重试

// ── 确定性失败特征：cloudflared 因配置/用法错误退出（非网络瞬态）─────────
// 这类失败重试无意义，识别后直接置 error 让用户看到明确原因，而不是
// 误判成"意外退出"退避重连 N 次（issue #35 作者建议）。
function isFatalCloudflaredError(stderrTail) {
  if (!stderrTail) return false;
  return /Incorrect Usage|flag provided but not defined|invalid.*token|unauthorized/i.test(stderrTail);
}

// 上游 release 不提供任何官方校验和文件（已核实 2024.10.0 资产清单），
// 因此无法做下载校验和比对；退而求其次：记录产物 SHA-256 指纹供事后审计比对。
async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(filePath)
      .on('data', (c) => hash.update(c))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

// 解析 cloudflared --version 输出（"cloudflared version 2024.10.0 (built ...)"）为版本号
export function parseCloudflaredVersion(output) {
  const m = /version\s+(\d{4}\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(output || '');
  return m ? m[1] : null;
}

function getCloudflaredInfo() {
  const os = platform();
  const cpuArch = arch();

  const platformMap = {
    'win32-x64':   { file: 'cloudflared-windows-amd64.exe', name: 'cloudflared.exe' },
    'win32-arm64': { file: 'cloudflared-windows-arm64.exe', name: 'cloudflared.exe' },
    'darwin-x64':  { file: 'cloudflared-darwin-amd64.tgz',  name: 'cloudflared' },
    'darwin-arm64':{ file: 'cloudflared-darwin-arm64.tgz',  name: 'cloudflared' },
    'linux-x64':   { file: 'cloudflared-linux-amd64',       name: 'cloudflared' },
    'linux-arm64': { file: 'cloudflared-linux-arm64',       name: 'cloudflared' },
  };

  const key = `${os}-${cpuArch}`;
  const info = platformMap[key];
  if (!info) throw new Error(`不支持的平台: ${os}-${cpuArch}`);

  const url = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${info.file}`;
  return { url, name: info.name };
}

async function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('下载超时（5分钟）')), DOWNLOAD_TIMEOUT);

    function doGet(targetUrl, redirects = 0) {
      if (redirects > 5) {
        clearTimeout(timer);
        return reject(new Error('重定向次数过多'));
      }
      httpsGet(targetUrl, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          res.resume();
          return doGet(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          clearTimeout(timer);
          return reject(new Error(`下载失败: HTTP ${res.statusCode}`));
        }

        const total = parseInt(res.headers['content-length'] ?? '0', 10);
        let downloaded = 0;
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (onProgress && total > 0) {
            onProgress(Math.round(downloaded / total * 100), downloaded, total);
          }
        });

        const fileStream = createWriteStream(dest);
        pipeline(res, fileStream)
          .then(() => { clearTimeout(timer); resolve(); })
          .catch((err) => { clearTimeout(timer); reject(err); });
      }).on('error', (err) => { clearTimeout(timer); reject(err); });
    }

    doGet(url);
  });
}

function findSystemCloudflared() {
  const isWin = platform() === 'win32';
  const candidates = [];
  if (isWin) {
    candidates.push('cloudflared.exe', 'cloudflared', 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe', 'C:\\Program Files\\cloudflared\\cloudflared.exe');
  } else {
    candidates.push('cloudflared', '/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared', '/usr/bin/cloudflared', '/bin/cloudflared');
  }

  for (const bin of candidates) {
    try {
      if (bin.includes('/') || bin.includes('\\')) {
        if (!existsSync(bin)) continue;
      }
      execSync(`"${bin}" --version`, { stdio: 'ignore', timeout: 3000 });
      return bin;
    } catch {}
  }
  return null;
}

export class CloudflaredManager {
  /**
   * @param {object} opts
   * @param {string} [opts.binaryPath] 直接指定可执行文件路径（测试注入假 cloudflared 用；
   *   生产不传，走 findSystemCloudflared → ~/.dsh-bridge/bin 的自动准备逻辑）。
   * @param {number} [opts.retryPolicy] 自愈重试策略：
   *   - false / null：禁用自动重启（保持旧版"意外退出置 error"行为）
   *   - 对象 { baseDelayMs, maxDelayMs, maxRetries }：覆盖默认退避参数（默认 5s→5min，12 次封顶）
   * @param {boolean} [opts.noAutoupdate=true] 是否禁用 cloudflared 自身的 autoupdate 自替换。
   *   autoupdate spawn 出的新进程不受本 manager 监督，会破坏"钉死版本 + 可自愈"的语义，默认必须关闭。
   * @param {string} [opts.binaryVersion=CLOUDFLARED_VERSION] 本 manager 期望管理的 cloudflared 版本。
   *   仅对自管理二进制（~/.dsh-bridge/bin）强制校验；系统级全局二进制尊重用户选择、不强制。
   * @param {number} [opts.handshakeTimeoutMs=90000] 等待隧道就绪的握手超时（测试可注入小值）。
   * @param {object} [opts.spawnOptions] 透传给 child_process.spawn 的额外选项（测试注入用，
   *   如 Windows 下需 shell:true 才能运行 .cmd mock；生产不传）。
   */
  constructor({ port, home, token, hostname, onStateChange, logger,
    binaryPath, retryPolicy, noAutoupdate = true, binaryVersion = CLOUDFLARED_VERSION,
    handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS, spawnOptions = null }) {
    this.port = port;
    this.home = home || join(homedir(), '.dsh-bridge');
    this.token = token ? String(token).trim() : null;
    this.hostname = hostname ? String(hostname).trim() : null;
    this.onStateChange = onStateChange;
    this.logger = logger;

    // 显式注入的可执行文件（测试用）：跳过自动查找/下载，直接按此路径运行
    this._injectedBinaryPath = binaryPath || null;

    // 自愈重试策略：默认开启；false/null 显式禁用（旧版行为）
    if (retryPolicy === false || retryPolicy === null) {
      this.retry = null;
    } else {
      const p = retryPolicy && typeof retryPolicy === 'object' ? retryPolicy : {};
      this.retry = {
        baseDelayMs: p.baseDelayMs ?? RETRY_BASE_MS,
        maxDelayMs: p.maxDelayMs ?? RETRY_MAX_MS,
        maxRetries: p.maxRetries ?? DEFAULT_MAX_RETRIES,
      };
    }

    this.noAutoupdate = noAutoupdate !== false;
    this.binaryVersion = binaryVersion || CLOUDFLARED_VERSION;
    this.handshakeTimeoutMs = handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    // 测试注入的 spawn 选项（如 Windows 的 shell）；生产为 null 不影响默认行为
    this._spawnOptions = spawnOptions || null;

    this.process = null;
    this.url = null;
    this.binaryPath = null;
    this._stopped = false;
    this._retryTimer = null;
    this._restartCount = 0; // 连续启动失败/意外退出次数，就绪后清零
  }

  // 异步启动，立即返回——调用方不需要 await
  start() {
    this._stopped = false;
    this._restartCount = 0;
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    this._setState('connecting', '正在初始化...');
    this._run().catch((err) => {
      this.logger?.error('cloudflared 启动失败: %s', err.message);
      // 确定性失败（用法错误/配置错误，如 Incorrect Usage）重试无意义 → 直接 error，
      // 让用户看到明确原因；瞬态失败（网络/握手/秒退）才退避自愈
      if (err && err.fatal) {
        this._setState('error', err.message);
        return;
      }
      this._scheduleRestart(`cloudflared 启动失败: ${err.message}`);
    });
  }

  async _run() {
    await this._ensureBinary();
    if (this._stopped) return;
    await this._startProcess();
  }

  // 退避自愈调度：唯一入口在"启动失败"与"就绪后意外退出"。stop()/超限 终止。
  _scheduleRestart(reason) {
    if (this._stopped) return; // 用户已停止，绝不复活
    if (this._retryTimer) return; // 已在倒计时中，避免叠加调度
    if (!this.retry) {
      this._setState('error', reason);
      return;
    }
    this._restartCount++;
    if (this._restartCount > this.retry.maxRetries) {
      this._setState('error', `${reason}（已自动重试 ${this.retry.maxRetries} 次仍失败，请检查网络/Token，或点击「关闭」停止）`);
      return;
    }
    const delay = Math.min(
      this.retry.baseDelayMs * 2 ** (this._restartCount - 1),
      this.retry.maxDelayMs
    );
    this._setState('reconnecting',
      `${reason}，${Math.max(1, Math.round(delay / 1000))}s 后自动重连（第 ${this._restartCount}/${this.retry.maxRetries} 次）`);
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._restartAttempt();
    }, delay);
  }

  // 一次实际的自愈尝试：成功（ready）后 _restartCount 清零，失败/退出由 exit/超时/异常再次调度
  _restartAttempt() {
    if (this._stopped) return;
    this._setState('connecting', '正在自动重连...');
    this._run().catch((err) => {
      this.logger?.error('cloudflared 自动重连失败: %s', err.message);
      // 自愈期间遇到确定性失败同样终止重试（如用户改坏配置后重启）
      if (err && err.fatal) {
        this._setState('error', err.message);
        return;
      }
      this._scheduleRestart(`cloudflared 启动失败: ${err.message}`);
    });
  }

  _terminateProcess() {
    const p = this.process;
    if (!p) return;
    try {
      if (platform() === 'win32') {
        // Windows 不支持 SIGTERM，用 taskkill 强制终止
        spawn('taskkill', ['/pid', String(p.pid), '/f', '/t'], { stdio: 'ignore' });
      } else {
        p.kill('SIGTERM');
      }
    } catch {}
  }

  // 校验自管理二进制是否匹配期望版本；系统级二进制不校验（尊重用户安装）
  _checkManagedBinaryVersion(binPath) {
    try {
      const out = execSync(`"${binPath}" --version`, { encoding: 'utf8', timeout: 3000 });
      const ver = parseCloudflaredVersion(out);
      if (!ver) return { ok: false, reason: `无法解析版本输出: ${(out || '').trim().slice(0, 80)}` };
      if (ver !== this.binaryVersion) {
        return { ok: false, reason: `版本不匹配: 期望 ${this.binaryVersion}，实际 ${ver}` };
      }
      return { ok: true, version: ver };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  async _ensureBinary() {
    // 0. 测试注入的可执行文件：直接使用，跳过查找/下载/版本校验
    if (this._injectedBinaryPath) {
      this.binaryPath = this._injectedBinaryPath;
      return;
    }

    // 1. 优先使用系统环境变量或 Homebrew / 包管理器已安装的全局二进制（尊重用户版本，不做强制校验）
    const systemBin = findSystemCloudflared();
    if (systemBin) {
      this.binaryPath = systemBin;
      this.logger?.info('优先使用系统全局 cloudflared: %s', systemBin);
      return;
    }

    const { url, name } = getCloudflaredInfo();
    const binDir = join(this.home, 'bin');
    const binPath = join(binDir, name);
    this.binaryPath = binPath;

    // 2. 检查本地 ~/.dsh-bridge/bin/cloudflared 是否已存在且可用
    if (existsSync(binPath)) {
      try {
        const s = await stat(binPath);
        if (s.size > MIN_BINARY_SIZE) { // >5MB 才视为有效二进制
          // 检查是否为历史残留未解压的 gzip 压缩包 (0x1f 0x8b)
          const fd = readFileSync(binPath);
          const isGzip = fd.length >= 2 && fd[0] === 0x1f && fd[1] === 0x8b;
          if (isGzip) {
            this.logger?.warn('检测到历史残留的未解压 cloudflared.tgz 压缩包，正在清理重新准备...');
            await unlink(binPath).catch(() => {});
          } else {
            // macOS / Linux 赋予可执行权限并清除 Gatekeeper 隔离属性
            if (platform() !== 'win32') {
              await chmod(binPath, 0o755).catch(() => {});
              if (platform() === 'darwin') {
                try { execSync(`xattr -d com.apple.quarantine "${binPath}"`, { stdio: 'ignore' }); } catch {}
              }
            }
            // 版本钉死校验：cloudflared autoupdate 可能已把钉死的版本自替换成新版，
            // 自管理二进制必须与期望版本一致，否则回滚重下——版本控制权留在插件手里。
            const check = this._checkManagedBinaryVersion(binPath);
            if (check.ok) {
              this.logger?.info('cloudflared 已存在且验证通过: %s (version=%s)', binPath, check.version);
              return;
            }
            this.logger?.warn('现有 cloudflared 二进制验证失败（%s），准备重新下载', check.reason);
          }
        }
      } catch (verifyErr) {
        this.logger?.warn('现有 cloudflared 二进制验证失败 (%s)，准备重新下载', verifyErr.message);
      }
      // 损坏 / 版本不符 / 无法执行：删掉重下
      await unlink(binPath).catch(() => {});
    }

    this._setState('downloading', '正在下载 cloudflared (~30MB)...');
    this.logger?.info('从 %s 下载 cloudflared', url);

    mkdirSync(binDir, { recursive: true });
    const tempPath = `${binPath}.tmp`;

    try {
      await downloadFile(url, tempPath, (percent, downloaded, total) => {
        if (this._stopped) return;
        const mb = (downloaded / 1024 / 1024).toFixed(1);
        const totalMb = (total / 1024 / 1024).toFixed(1);
        this._setState('downloading', `下载 cloudflared: ${mb}/${totalMb} MB (${percent}%)`);
      });

      if (url.endsWith('.tgz') || url.endsWith('.tar.gz')) {
        try {
          execSync(`tar -xzf "${tempPath}" -C "${binDir}"`);
          await unlink(tempPath).catch(() => {});
        } catch (tarErr) {
          this.logger?.error('解压 cloudflared 压缩包失败: %s', tarErr.message);
          throw new Error(`解压 cloudflared 失败: ${tarErr.message}`, { cause: tarErr });
        }
      } else {
        if (existsSync(binPath)) await unlink(binPath).catch(() => {});
        await rename(tempPath, binPath);
      }

      if (platform() !== 'win32') {
        await chmod(binPath, 0o755).catch(() => {});
        if (platform() === 'darwin') {
          try { execSync(`xattr -d com.apple.quarantine "${binPath}"`, { stdio: 'ignore' }); } catch {}
        }
      }

      // 下载产物也必须通过版本校验（钉死版本）
      const check = this._checkManagedBinaryVersion(binPath);
      if (!check.ok) {
        throw new Error(`下载的 cloudflared 版本校验失败: ${check.reason}`);
      }
      this.logger?.info('cloudflared 下载并准备完成 (version=%s, sha256=%s)', check.version, await sha256File(binPath));
    } catch (err) {
      await unlink(tempPath).catch(() => {});
      throw new Error(`准备 cloudflared 失败: ${err.message}`, { cause: err });
    }
  }

  _startProcess() {
    return new Promise((resolve, reject) => {
      if (this._stopped) return reject(new Error('已取消'));

      this._setState('connecting', this._restartCount > 0 ? '正在自动重连...' : '正在连接 Cloudflare...');

      const args = this.token
        // --no-autoupdate 是 tunnel 子命令的全局 flag，须在 run 之前（cloudflared 2024.10.0，issue #35）
        ? ['tunnel', ...(this.noAutoupdate ? ['--no-autoupdate'] : []), 'run', '--token', this.token]
        : ['tunnel', ...(this.noAutoupdate ? ['--no-autoupdate'] : []), '--url', `http://127.0.0.1:${this.port}`];

      // 隐藏日志中的 token 敏感字段
      const safeArgs = this.token ? args.map((a) => (a === this.token ? '***' : a)) : args;
      this.logger?.info('启动 cloudflared: %s %s', this.binaryPath, safeArgs.join(' '));

      // 环境变量双保险禁用 autoupdate（部分打包/脚本以 env 方式读取）
      const spawnEnv = this.noAutoupdate
        ? { ...process.env, NO_AUTOUPDATE: 'true' }
        : process.env;

      const proc = spawn(this.binaryPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: spawnEnv,
        ...(this._spawnOptions || {}),
      });
      this.process = proc;

      let resolved = false;
      let timeoutTimer = null;
      // 累积 stderr 尾部（供 exit 时判断确定性失败：CLI 用法错误 / 配置错误）
      let stderrTail = '';

      // 仅当当前引用的仍是本次 spawn 的进程时才清空——自愈重启后旧进程的
      // exit 事件可能晚于新进程 spawn 触发；exit handler 内用 stillCurrent
      // （this.process === proc）判定，避免误清新进程引用（stop() 将无法终止它）。

      const tryResolve = () => {
        if (!resolved) {
          resolved = true;
          if (timeoutTimer) {
            clearTimeout(timeoutTimer);
            timeoutTimer = null;
          }
          // 就绪即证明链路可用，连续失败计数清零
          this._restartCount = 0;
          resolve();
        }
      };

      // 1. 命名/Token 隧道：通过握手日志判定就绪，使用预设固定域名
      const parseNamedTunnel = (text) => {
        if (!this.token) return;
        if (
          (text.includes('Registered tunnel') ||
           text.includes('registered connIndex') ||
           text.includes('Connection') && text.includes('registered') ||
           text.includes('Updated to new configuration') ||
           text.includes('Route propagated')) &&
          !resolved
        ) {
          let fixedUrl = this.hostname
            ? (this.hostname.startsWith('http') ? this.hostname : `https://${this.hostname}`)
            : null;
          this.url = fixedUrl;
          this._setState('ready', fixedUrl ? `固定隧道已建立 (${fixedUrl})` : '固定隧道已建立');
          this.logger?.info('cloudflared 固定隧道就绪: %s', this.url || 'Token 模式');
          tryResolve();
        }
      };

      // 2. 免费临时隧道：从 stdout/stderr 解析随机分配的 trycloudflare.com 域名
      const parseUrl = (text) => {
        if (this.token) {
          parseNamedTunnel(text);
          return;
        }
        const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match && !resolved) {
          this.url = match[0];
          this._setState('ready', '临时隧道已建立');
          this.logger?.info('cloudflared 临时隧道就绪: %s', this.url);
          tryResolve();
        }
      };

      proc.stdout.on('data', (d) => parseUrl(d.toString()));
      proc.stderr.on('data', (d) => {
        const text = d.toString();
        this.logger?.debug('cloudflared: %s', text.trim());
        stderrTail = (stderrTail + text).slice(-2000); // 只保留尾部 2KB
        parseUrl(text);
        if (text.includes('Registered tunnel') && !resolved) {
          this._setState('connecting', '隧道已注册，等待就绪...');
        }
      });

      proc.on('exit', (code, signal) => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        // exit 时"仍是当前进程"才允许清理引用 + 调度自愈。
        // 自愈已 spawn 新进程后，旧进程迟到的 exit 不满足 stillCurrent → 静默，
        // 避免"新进程连接中、旧 exit 又触发一次重启"的竞态（否则会叠出第三进程）。
        const stillCurrent = this.process === proc;
        if (stillCurrent) this.process = null;
        this.url = null;
        if (!resolved) {
          // 就绪前退出 = 启动失败，交给 reject → start()/restart 的 catch 进入退避自愈。
          // 若 stderr 显示确定性配置/用法错误（Incorrect Usage 等）→ 标 fatal，
          // catch 收到后直接置 error，不再无意义退避重连。
          const msg = `cloudflared 启动失败: ${isFatalCloudflaredError(stderrTail) ? '配置错误（' + (stderrTail.trim().split('\n').pop() || '请检查 Token 与参数') + '）' : `cloudflared 退出，code=${code ?? ''} signal=${signal ?? ''}`}`;
          const err = new Error(msg);
          if (isFatalCloudflaredError(stderrTail)) err.fatal = true;
          reject(err);
        } else if (!this._stopped && stillCurrent) {
          // 就绪后的意外退出（崩溃 / OOM / 误杀 / autoupdate 残留自替换）→ 退避自愈
          this._scheduleRestart(`cloudflared 进程意外退出 (code=${code ?? ''}${signal ? `, ${signal}` : ''})`);
        } else {
          this._setState('idle', '');
        }
      });

      proc.on('error', (err) => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        if (!resolved) reject(err);
      });

      // 握手超时：只终止进程、不置 _stopped——让退出/重试路径接管（kill 后进程
      // exit 会触发 reject；此处兜底 reject 保证进程僵死时也能推进）
      timeoutTimer = setTimeout(() => {
        if (!resolved) {
          this.logger?.warn('等待隧道 URL 超时（%ss），终止进程并进入自动重试', Math.round(this.handshakeTimeoutMs / 1000));
          this._terminateProcess();
          reject(new Error(`等待隧道 URL 超时（${Math.round(this.handshakeTimeoutMs / 1000)}秒）`));
        }
      }, this.handshakeTimeoutMs);
    });
  }

  _setState(phase, detail) {
    this.onStateChange?.({ phase, detail });
  }

  stop() {
    this._stopped = true;
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    this._restartCount = 0;
    if (this.process) {
      this.logger?.info('停止 cloudflared...');
      this._terminateProcess();
      this.process = null;
    }
    this.url = null;
    this._setState('idle', '');
  }
}
