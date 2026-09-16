# orangebot

discord.js と TypeScript（ESM）で作る Discord ボット。

## セットアップ

```bash
npm install
cp .env.example .env   # PowerShell なら: Copy-Item .env.example .env
```

`.env` に Discord Developer Portal から取得した値を入れる。

| 変数                | 必須 | 説明                                                  |
| ------------------- | ---- | ----------------------------------------------------- |
| `DISCORD_TOKEN`     | ✅   | Bot タブのトークン                                    |
| `DISCORD_CLIENT_ID` | ✅   | アプリケーション ID                                   |
| `DISCORD_GUILD_ID`  |      | 開発用サーバー ID。指定するとコマンドが即時反映される |
| `NODE_ENV`          |      | `development` / `production` / `test`                 |
| `LOG_LEVEL`         |      | `debug` / `info` / `warn` / `error`（既定は `info`）  |

## 開発

```bash
npm run commands:deploy   # スラッシュコマンドを Discord に登録
npm run dev               # 変更を監視しながら起動
```

## スクリプト

| コマンド                  | 内容                                     |
| ------------------------- | ---------------------------------------- |
| `npm run dev`             | tsx watch で起動                         |
| `npm run build`           | `dist/` に JavaScript を出力             |
| `npm start`               | ビルド済みの `dist/index.js` を実行      |
| `npm run typecheck`       | 型チェックのみ                           |
| `npm run lint`            | ESLint                                   |
| `npm run format`          | Prettier で整形                          |
| `npm test`                | Vitest（1 回実行）                       |
| `npm run test:coverage`   | カバレッジ付きテスト                     |
| `npm run commands:deploy` | スラッシュコマンドの登録                 |
| `npm run check`           | 型チェック + Lint + テストをまとめて実行 |

## 構成

```
src/
  index.ts              エントリポイント（起動とシグナル処理）
  bot.ts                Client の生成とイベント配線
  env.ts                環境変数の検証
  logger.ts             簡易ロガー
  commands/
    index.ts            コマンドレジストリ
    types.ts            Command インターフェース
    ping.ts             /ping
  scripts/
    deploy-commands.ts  スラッシュコマンド登録スクリプト
```

## コマンドの追加

1. `src/commands/` に `Command` を満たすモジュールを作る。
2. `src/commands/index.ts` の `commands` 配列に追加する。
3. `npm run commands:deploy` で Discord に登録する。

ESM + `moduleResolution: NodeNext` のため、相対 import には `.js` 拡張子を付ける。
