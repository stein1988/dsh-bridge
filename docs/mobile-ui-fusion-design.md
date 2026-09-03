# dsh-bridge 移动端优化说明

> 状态：**已完成**（`feat/mobile-css-v2102` 分支）
> 基线：基于上游 `v2.10.2`

手机浏览器访问 dsh-bridge 代理/隧道时，看到的是 DSH 桌面 Web UI。本优化通过 dsh-bridge 的 client 插件注入移动专用 CSS，把桌面 UI 改造成移动端友好的布局——**不引入独立单页**，保留 Web 客户端全部能力（提问审批、模型/Preset 选择、设置中心等天然可用）。

---

## 已落地的改动（`client/mobile-styles.js` + `client/index.js`）

### 1. 顶部精简
- 隐藏"创造模式"Preset 徽标、Session log 下载按钮、"对话/轨迹" tab
- 折叠已空的内容区 header 行，把纵向空间让给聊天内容

### 2. 输入框优化
- 圆角 26px → 18px，内边距收紧（8px 10px 7px）
- 字号 16px → 15px，底部留白 16px → 8px（贴底下移）
- 修复光标偏移：input/mirror/backdrop 三层显式锁定同一 font-size / line-height / padding，避免透明 textarea 与背后 mirror 错位

### 3. 聊天内容紧凑化
- 正文 16px → 14px，行距 1.55，段距 8px
- 标题 h1/h2/h3 阶梯缩小（17/16/15px）
- 隐藏输入框左侧工具组（命令按钮 + Full access 选择器），给右侧控件让空间

### 4. 轨迹页逃生
- 顶部 tab 在移动端隐藏，但误入轨迹视图时会困住
- 在 `client/index.js` 加入检测：非对话视图时，左上角注入"← 对话"悬浮按钮，点击切回对话；回到对话后自动消失

---

## 验证

在浏览器窗口缩窄至 <769px（或手机访问）刷新页面即可看到效果；桌面宽屏（>769px）不受影响。
