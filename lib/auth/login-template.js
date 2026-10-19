// lib/auth/login-template.js
// DeepSeek Harness 官方质感高颜值远程访问认证登录页（零外部 CDN 依赖，响应式适配手机与桌面）

// 登录页文案（中 / 英）。语言来源：服务端按请求的 Accept-Language 传 lang
// （缺省/zh 开头 → 中文，保持改造前行为；其它 → 英文）；页面内联脚本用注入的 I18N
// 渲染动态文案，并把 auth/manager.js 返回的已知中文错误映射成英文（未知文案原样显示，
// 不编造）。
const LOGIN_I18N = {
  zh: {
    title: '远程访问认证 - DeepSeek Harness',
    heading: '远程安全访问认证',
    headingNoPassword: '远程访问 · 尚未设置密码',
    label: '访问密码 / PIN 码',
    toggleTitle: '显示/隐藏密码',
    unlock: '解锁并访问',
    placeholderWithPassword: '请输入管理员设置的访问密码',
    placeholderNoPassword: '（尚未设置密码）',
    placeholderAsk: '请输入访问密码',
    noticePasswordOnly: '管理员尚未设置访问密码（仅密码模式），请联系管理员在控制台「安全认证」中设置密码后再访问。',
    buttonPasswordOnly: '无法访问（未设置密码）',
    noticeTokenOnly: '当前为「仅安全 Token」模式，请使用管理员分享的专属二维码或带 Token 的链接访问（不支持密码登录）。',
    buttonTokenOnly: '需专属 Token',
    noticeOpen: '当前访问认证已开启，但管理员尚未设置任何访问密码 —— 免密开放状态，任何访客均可直接进入。请管理员尽快在控制台「安全认证」中设置访问密码。',
    buttonOpen: '直接进入',
    tokenOnlyHint: '仅凭专属 Token 进入 · 无 Token 将无法访问',
    openHint: '当前为免密开放状态 · 请管理员尽快在控制台设置访问密码',
    forgot: '❓ 忘记密码怎么办？',
    guideTitle: '🛟 找回与重置密码指引：',
    guide1: '1. <strong>电脑本机免密直连</strong>：在运行本程序的电脑本机打开本控制台，物理机享有永久免密特权，可直接修改或清除密码。',
    guide2: '2. <strong>服务器 / 无头环境</strong>：救急重置步骤请参见 <a href="https://github.com/wenbin-wb/dsh-bridge#readme" target="_blank" style="color: #93c5fd;">GitHub README</a> 的「三重容灾保命体系」章节。',
    footer: '由 <a href="https://github.com/wenbin-wb/dsh-bridge" target="_blank">dsh-bridge</a> 安全网关守护',
    verifying: '验证中…',
    success: '✓ 认证成功，正在跳转…',
    fallbackError: '访问密码错误',
    networkError: '网络请求失败，请重试',
    errors: {
      '访问密码错误': '访问密码错误',
      '尝试次数过多，请稍后再试': '尝试次数过多，请稍后再试',
      '尝试次数过多，请 60 秒后再试': '尝试次数过多，请 60 秒后再试',
      '当前仅允许专属安全 Token 扫码访问，不支持密码登录': '当前仅允许专属安全 Token 扫码访问，不支持密码登录',
    },
  },
  en: {
    title: 'Remote access authentication - DeepSeek Harness',
    heading: 'Remote secure access authentication',
    headingNoPassword: 'Remote access · no password set',
    label: 'Access password / PIN',
    toggleTitle: 'Show/hide password',
    unlock: 'Unlock and continue',
    placeholderWithPassword: 'Enter the access password set by the administrator',
    placeholderNoPassword: '(no password set yet)',
    placeholderAsk: 'Enter the access password',
    noticePasswordOnly: 'The administrator has not set an access password (password-only mode). Ask them to set one under “Security” in the console, then try again.',
    buttonPasswordOnly: 'Unavailable (no password set)',
    noticeTokenOnly: 'This bridge is in “Security Token only” mode. Use the dedicated QR code or the Token link shared by the administrator (password login is disabled).',
    buttonTokenOnly: 'Token required',
    noticeOpen: 'Access protection is enabled but the administrator has not set any password — the entry is currently open to anyone. Ask the administrator to set an access password under “Security” in the console.',
    buttonOpen: 'Enter anyway',
    tokenOnlyHint: 'Dedicated Token required · access without a Token is denied',
    openHint: 'Currently open (no password) · ask the administrator to set an access password',
    forgot: '❓ Forgot the password?',
    guideTitle: '🛟 How to recover or reset the password:',
    guide1: '1. <strong>From the computer itself</strong>: open this console on the machine running the program — the physical machine always has password-free access, so you can change or clear the password at any time.',
    guide2: '2. <strong>Server / headless environment</strong>: see the <a href="https://github.com/wenbin-wb/dsh-bridge/blob/main/README.en.md" target="_blank" style="color: #93c5fd;">English README</a> section “Triple Disaster Recovery (Never Locked Out)”.',
    footer: 'Protected by the <a href="https://github.com/wenbin-wb/dsh-bridge" target="_blank">dsh-bridge</a> security gateway',
    verifying: 'Verifying…',
    success: '✓ Authenticated, redirecting…',
    fallbackError: 'Incorrect access password',
    networkError: 'Network request failed, please retry',
    errors: {
      '访问密码错误': 'Incorrect access password',
      '尝试次数过多，请稍后再试': 'Too many attempts, please try again later',
      '尝试次数过多，请 60 秒后再试': 'Too many attempts, please try again in 60 seconds',
      '当前仅允许专属安全 Token 扫码访问，不支持密码登录': 'Only dedicated Security Token access is allowed; password login is disabled',
    },
  },
};

/**
 * 登录页与登录错误共用的语言判定：缺省或 zh 开头 → 中文（保持改造前行为），
 * 其余（en/de/ja/fr/* 等）→ 英文。两处必须共用，否则会出现「英文登录页 + 中文报错」。
 * @param {string} [acceptLanguage] 请求的 Accept-Language 头
 * @returns {'zh'|'en'}
 */
export function pickLoginLang(acceptLanguage = '') {
  const value = String(acceptLanguage || '').toLowerCase();
  return !value || value.startsWith('zh') ? 'zh' : 'en';
}

/** 服务端认证错误的中英映射：英文请求返回英文文案，未知文案原样返回（不编造）。 */
export function localizeAuthError(message, lang = 'zh') {
  if (!message) return message;
  if (!String(lang || '').toLowerCase().startsWith('en')) return message;
  return LOGIN_I18N.en.errors[message] || message;
}

export function renderLoginPage({ error = '', hasPassword = true, locked = false, noPasswordConfigured = false, mode = 'token_and_password', lang = 'zh' } = {}) {
  // 管理员从未设置任何密码时的如实提示：
  //  - password_only 模式：门禁真实存在但管理员未初始化密码，登录页应明确告知，
  //    而不是让访客试一个永远不对的密码。
  //  - token_and_password（默认）：认证已开启但无任何密码可校验，密码登录对任意
  //    输入都放行（宽松降级），如实提示"免密开放"避免假门禁误导。
  //  - token_only：仅专属 Token 可进，与密码无关，提示走二维码 / Token 链接。
  const isEn = String(lang || '').toLowerCase().startsWith('en');
  const L = LOGIN_I18N[isEn ? 'en' : 'zh'];
  // 已知中文错误在英文页面里映射为英文；未知文案原样显示（不编造）
  const localizeError = (message) => localizeAuthError(message, isEn ? 'en' : 'zh');
  let noPasswordNotice = '';
  let buttonLabel = L.unlock;
  if (noPasswordConfigured) {
    if (mode === 'password_only') {
      noPasswordNotice = L.noticePasswordOnly;
      buttonLabel = L.buttonPasswordOnly;
    } else if (mode === 'token_only') {
      noPasswordNotice = L.noticeTokenOnly;
      buttonLabel = L.buttonTokenOnly;
    } else {
      noPasswordNotice = L.noticeOpen;
      buttonLabel = L.buttonOpen;
    }
  }
  const heading = noPasswordConfigured ? L.headingNoPassword : L.heading;
  const inputPlaceholder = hasPassword
    ? L.placeholderWithPassword
    : (noPasswordConfigured ? L.placeholderNoPassword : L.placeholderAsk);
  const errorText = localizeError(error);
  return `<!DOCTYPE html>
<html lang="${isEn ? 'en' : 'zh-CN'}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="theme-color" content="#121413">
  <title>${L.title}</title>
  <style>
    :root {
      --bg: #121413;
      --card-bg: rgba(26, 29, 27, 0.85);
      --card-border: rgba(255, 255, 255, 0.08);
      --brand: #22c55e;
      --brand-hover: #16a34a;
      --brand-glow: rgba(34, 197, 94, 0.25);
      --text: #f3f4f6;
      --text-secondary: #9ca3af;
      --input-bg: rgba(18, 20, 19, 0.7);
      --input-border: rgba(255, 255, 255, 0.12);
      --error-bg: rgba(239, 68, 68, 0.12);
      --error-border: rgba(239, 68, 68, 0.3);
      --error-text: #f87171;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      -webkit-tap-highlight-color: transparent;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
      background-color: var(--bg);
      background-image: 
        radial-gradient(circle at 50% 0%, rgba(34, 197, 94, 0.12) 0%, transparent 50%),
        radial-gradient(circle at 100% 100%, rgba(16, 185, 129, 0.05) 0%, transparent 40%);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }

    .container {
      width: 100%;
      max-width: 400px;
      perspective: 1000px;
    }

    .card {
      background: var(--card-bg);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--card-border);
      border-radius: 20px;
      padding: 36px 28px;
      box-shadow: 
        0 20px 40px -15px rgba(0, 0, 0, 0.5),
        0 0 0 1px rgba(255, 255, 255, 0.05);
      animation: fadeIn 0.4s cubic-bezier(0.16, 1, 0.3, 1);
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(16px) scale(0.98); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    .logo-area {
      text-align: center;
      margin-bottom: 28px;
    }

    .logo-icon {
      width: 56px;
      height: 56px;
      margin: 0 auto 16px;
      border-radius: 16px;
      background: linear-gradient(135deg, rgba(34, 197, 94, 0.2), rgba(16, 185, 129, 0.05));
      border: 1px solid rgba(34, 197, 94, 0.3);
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 8px 16px -4px var(--brand-glow);
    }

    .logo-icon svg {
      width: 32px;
      height: 32px;
      fill: var(--brand);
    }

    h1 {
      font-size: 20px;
      font-weight: 600;
      letter-spacing: -0.01em;
      color: #ffffff;
      margin-bottom: 6px;
    }

    .subtitle {
      font-size: 13px;
      color: var(--text-secondary);
      line-height: 1.5;
    }

    .alert {
      background: var(--error-bg);
      border: 1px solid var(--error-border);
      color: var(--error-text);
      padding: 10px 14px;
      border-radius: 10px;
      font-size: 13px;
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      gap: 8px;
      animation: shake 0.4s ease;
    }

    @keyframes shake {
      0%, 100% { transform: translateX(0); }
      20%, 60% { transform: translateX(-6px); }
      40%, 80% { transform: translateX(6px); }
    }

    .form-group {
      margin-bottom: 20px;
    }

    label {
      display: block;
      font-size: 12px;
      font-weight: 500;
      color: var(--text-secondary);
      margin-bottom: 8px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .input-wrapper {
      position: relative;
      display: flex;
      align-items: center;
    }

    input[type="password"], input[type="text"] {
      width: 100%;
      background: var(--input-bg);
      border: 1px solid var(--input-border);
      border-radius: 12px;
      padding: 14px 44px 14px 16px;
      font-size: 15px;
      color: #ffffff;
      outline: none;
      transition: all 0.2s ease;
      font-family: inherit;
    }

    input:focus {
      border-color: var(--brand);
      box-shadow: 0 0 0 3px var(--brand-glow);
      background: rgba(18, 20, 19, 0.9);
    }

    .toggle-pwd {
      position: absolute;
      right: 12px;
      background: none;
      border: none;
      cursor: pointer;
      color: var(--text-secondary);
      padding: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 6px;
      transition: color 0.2s;
    }

    .toggle-pwd:hover {
      color: #ffffff;
    }

    .submit-btn {
      width: 100%;
      background: var(--brand);
      color: #0b150f;
      border: none;
      border-radius: 12px;
      padding: 14px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      box-shadow: 0 4px 12px var(--brand-glow);
    }

    .submit-btn:hover {
      background: var(--brand-hover);
      transform: translateY(-1px);
      box-shadow: 0 6px 16px rgba(34, 197, 94, 0.35);
    }

    .submit-btn:active {
      transform: translateY(1px);
    }

    .submit-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }

    .spinner {
      width: 18px;
      height: 18px;
      border: 2px solid rgba(11, 21, 15, 0.3);
      border-top-color: #0b150f;
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
      display: none;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .footer {
      text-align: center;
      margin-top: 24px;
      font-size: 12px;
      color: rgba(255, 255, 255, 0.35);
    }

    .footer a {
      color: var(--text-secondary);
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="logo-area">
        <div class="logo-icon">
          <svg viewBox="0 0 24 24">
            <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/>
          </svg>
        </div>
        <h1>DeepSeek Harness</h1>
        <div class="subtitle">${heading}</div>
      </div>

      ${noPasswordNotice ? `
      <div id="noPwdNotice" style="background: rgba(245,158,11,0.12); border: 1px solid rgba(245,158,11,0.35); color: #fbbf24; padding: 10px 14px; border-radius: 10px; font-size: 13px; line-height: 1.6; margin-bottom: 16px; display: flex; align-items: flex-start; gap: 8px;">
        <span style="flex-shrink:0;">⚠️</span>
        <span>${noPasswordNotice}</span>
      </div>` : ''}

      <div id="errorAlert" class="alert" style="${errorText ? '' : 'display: none;'}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
        <span id="errorMsg">${errorText}</span>
      </div>

      <form id="loginForm" onsubmit="return handleLogin(event)">
        <div class="form-group">
          <label for="password">${L.label}</label>
          <div class="input-wrapper">
            <input type="password" id="password" name="password" placeholder="${inputPlaceholder}" autocomplete="current-password" autofocus ${hasPassword ? 'required' : ''}>
            <button type="button" class="toggle-pwd" onclick="togglePassword()" title="${L.toggleTitle}">
              <svg id="eyeIcon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                <circle cx="12" cy="12" r="3"></circle>
              </svg>
            </button>
          </div>
        </div>

        <button type="submit" id="submitBtn" class="submit-btn">
          <span class="spinner" id="btnSpinner"></span>
          <span id="btnText">${buttonLabel}</span>
        </button>
      </form>

      ${!hasPassword && noPasswordConfigured && mode !== 'password_only' ? `
      <div style="margin-top: 12px; text-align: center;">
        <span style="font-size: 12px; color: rgba(255,255,255,0.45);">${mode === 'token_only' ? L.tokenOnlyHint : L.openHint}</span>
      </div>` : ''}

      <div style="margin-top: 16px; text-align: center;">
        <a href="javascript:void(0)" onclick="toggleForgotGuide()" style="font-size: 12px; color: var(--text-secondary); text-decoration: none; display: inline-flex; align-items: center; gap: 4px; transition: color 0.2s;">
          ${L.forgot}
        </a>
      </div>

      <div id="forgotGuide" style="display: none; margin-top: 14px; padding: 12px 14px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; font-size: 12px; line-height: 1.6; color: var(--text-secondary); text-align: left;">
        <div style="font-weight: 600; color: #f3f4f6; margin-bottom: 4px;">${L.guideTitle}</div>
        <div>${L.guide1}</div>
        <div style="margin-top: 4px;">${L.guide2}</div>
      </div>

      <div class="footer">
        ${L.footer}
      </div>
    </div>
  </div>

  <script>
    const I18N = ${JSON.stringify({ verifying: L.verifying, success: L.success, fallbackError: L.fallbackError, networkError: L.networkError, unlock: L.unlock })};
    function toggleForgotGuide() {
      const g = document.getElementById('forgotGuide');
      g.style.display = g.style.display === 'none' ? 'block' : 'none';
    }

    function togglePassword() {
      const input = document.getElementById('password');
      const icon = document.getElementById('eyeIcon');
      if (input.type === 'password') {
        input.type = 'text';
        icon.innerHTML = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>';
      } else {
        input.type = 'password';
        icon.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>';
      }
    }

    async function handleLogin(e) {
      e.preventDefault();
      const pwd = document.getElementById('password').value;
      const btn = document.getElementById('submitBtn');
      const spinner = document.getElementById('btnSpinner');
      const btnText = document.getElementById('btnText');
      const alert = document.getElementById('errorAlert');
      const errorMsg = document.getElementById('errorMsg');

      btn.disabled = true;
      spinner.style.display = 'inline-block';
      btnText.textContent = I18N.verifying;
      alert.style.display = 'none';

      try {
        const resp = await fetch('/__dsh_bridge__/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pwd })
        });
        const data = await resp.json();
        if (data.ok) {
          btnText.textContent = I18N.success;
          setTimeout(() => {
            window.location.reload();
          }, 300);
        } else {
          errorMsg.textContent = data.error || I18N.fallbackError;
          alert.style.display = 'flex';
          alert.style.animation = 'none';
          void alert.offsetWidth; // Force a reflow
          alert.style.animation = 'shake 0.4s ease';
          btn.disabled = false;
          spinner.style.display = 'none';
          btnText.textContent = I18N.unlock;
          document.getElementById('password').focus();
          document.getElementById('password').select();
        }
      } catch (err) {
        errorMsg.textContent = I18N.networkError;
        alert.style.display = 'flex';
        btn.disabled = false;
        spinner.style.display = 'none';
        btnText.textContent = I18N.unlock;
      }
      return false;
    }
  </script>
</body>
</html>`;
}
