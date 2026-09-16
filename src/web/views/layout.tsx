import type { Child } from 'hono/jsx';
import { html, raw } from 'hono/html';

const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #fbfaf8;
  --panel: #ffffff;
  --ink: #1b1a18;
  --muted: #6b6560;
  --line: #e4ded6;
  --accent: #d9662a;
  --accent-soft: #fbeade;
  --ok: #2f7d4f;
  --warn: #9a6a12;
  --bad: #b23b2e;
  --mono: ui-monospace, "SFMono-Regular", "Cascadia Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #17161a;
    --panel: #201e24;
    --ink: #ece8e3;
    --muted: #9d968e;
    --line: #322f38;
    --accent: #f08243;
    --accent-soft: #3a2519;
    --ok: #74c28c;
    --warn: #d4a83c;
    --bad: #e8796a;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 15px/1.7 system-ui, -apple-system, "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif;
}
.wrap { max-width: 960px; margin: 0 auto; padding: 0 16px 64px; }
header.top {
  border-bottom: 1px solid var(--line);
  background: var(--panel);
  margin-bottom: 28px;
}
header.top .wrap { padding-block: 14px; display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap; }
header.top a.brand {
  font-weight: 700; font-size: 17px; color: var(--ink); text-decoration: none;
  display: inline-flex; align-items: baseline; gap: 7px;
}
header.top a.brand::before {
  content: ""; width: 9px; height: 9px; border-radius: 50%;
  background: var(--accent); display: inline-block;
}
header.top nav { margin-left: auto; display: flex; gap: 14px; flex-wrap: wrap; }
header.top nav a { color: var(--muted); text-decoration: none; font-size: 14px; }
header.top nav a:hover { color: var(--accent); }
h1 { font-size: 24px; letter-spacing: .01em; margin: 0 0 6px; }
h2 { font-size: 17px; margin: 32px 0 10px; }
p.lede { color: var(--muted); margin: 0 0 22px; }
section.panel {
  background: var(--panel); border: 1px solid var(--line);
  border-radius: 10px; padding: 16px 18px; margin-bottom: 18px;
}
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-size: 12.5px; letter-spacing: .04em; }
tr:last-child td { border-bottom: none; }
.scroll { overflow-x: auto; }
code, .mono { font-family: var(--mono); font-size: 12.5px; }
.tag {
  display: inline-block; padding: 1px 8px; border-radius: 999px;
  font-size: 12px; border: 1px solid var(--line); color: var(--muted); white-space: nowrap;
}
.tag.ok { color: var(--ok); border-color: currentColor; }
.tag.warn { color: var(--warn); border-color: currentColor; }
.tag.bad { color: var(--bad); border-color: currentColor; }
.tag.accent { color: var(--accent); border-color: currentColor; background: var(--accent-soft); }
.muted { color: var(--muted); }
.big { font-size: 26px; font-weight: 700; letter-spacing: -.01em; }
.grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); }
.stat { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 13px 15px; }
.stat .k { color: var(--muted); font-size: 12.5px; }
footer.foot { color: var(--muted); font-size: 13px; border-top: 1px solid var(--line); padding-top: 14px; margin-top: 40px; }
.banner { border-radius: 10px; padding: 13px 16px; margin-bottom: 18px; border: 1px solid; }
.banner.ok { color: var(--ok); }
.banner.bad { color: var(--bad); }

form.stack { display: flex; flex-direction: column; gap: 15px; max-width: 460px; }
.field { display: flex; flex-direction: column; gap: 5px; }
.field-label { font-size: 13.5px; font-weight: 600; }
.field-hint { font-size: 12.5px; color: var(--muted); line-height: 1.55; }
.input {
  font: inherit; color: var(--ink); background: var(--panel);
  border: 1px solid var(--line); border-radius: 8px; padding: 9px 11px; width: 100%;
}
.input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
textarea.input { resize: vertical; }
.btn {
  font: inherit; font-weight: 600; cursor: pointer; align-self: flex-start;
  background: var(--accent); color: #fff; border: none;
  border-radius: 8px; padding: 9px 20px;
}
.btn:hover { filter: brightness(1.07); }
.btn.danger { background: var(--bad); }
.btn.quiet { background: transparent; color: var(--muted); border: 1px solid var(--line); }
.row { display: flex; gap: 9px; align-items: center; flex-wrap: wrap; }
.secret-list { font-size: 14px; margin: 8px 0 0; padding-left: 26px; line-height: 2; }
.panel.secret { border-style: dashed; }
.qr { background: #fff; padding: 12px; border-radius: 10px; display: inline-block; }
.qr img { display: block; width: 190px; height: 190px; }
.steps { counter-reset: step; list-style: none; padding: 0; margin: 0 0 24px; }
.steps li { color: var(--muted); font-size: 13.5px; padding: 3px 0 3px 30px; position: relative; }
.steps li::before {
  counter-increment: step; content: counter(step);
  position: absolute; left: 0; top: 4px;
  width: 20px; height: 20px; border-radius: 50%; text-align: center;
  font-size: 11.5px; line-height: 20px; background: var(--line); color: var(--ink);
}
.steps li.now { color: var(--ink); font-weight: 600; }
.steps li.now::before { background: var(--accent); color: #fff; }
a.plain { color: var(--accent); }
.bad-text { color: var(--bad); }
.post-body { white-space: pre-wrap; overflow-wrap: anywhere; margin: 10px 0; }
.post-meta { gap: 14px; font-size: 13.5px; }
.post.replying { border-color: var(--accent); }
.btn:disabled { filter: grayscale(.6); cursor: progress; }
`;

export interface LayoutProps {
  readonly title: string;
  readonly children?: Child | undefined;
  /** ログイン中の表示名。未ログインなら undefined。 */
  readonly viewer?: string | undefined;
  /** 埋め込む script。パスキーの画面だけが使う。 */
  readonly script?: string | undefined;
}

export function Layout(props: LayoutProps) {
  return html`<!doctype html>
    <html lang="ja">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>${props.title} · orangebot</title>
        <style>
          ${raw(STYLES)}
        </style>
      </head>
      <body>
        <header class="top">
          <div class="wrap">
            <a class="brand" href="/">orangebot</a>
            <nav>
              <a href="/status">状態</a>
              ${
                props.viewer === undefined
                  ? html`<a href="/login">ログイン</a>`
                  : html`<a href="/timeline">タイムライン</a>
                      <a href="/proposals">提案</a>
                      <a href="/wallet">ウォレット</a>
                      <a href="/settings">設定</a>
                      <span class="muted">${props.viewer}</span>`
              }
            </nav>
          </div>
        </header>
        <main class="wrap">${props.children}</main>
        ${props.script === undefined ? '' : html`<script>
          ${raw(props.script)}
        </script>`}
      </body>
    </html>`;
}
