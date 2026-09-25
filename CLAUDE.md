# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Sych Bot is a Telegram bot with hybrid AI architecture (OpenRouter primary, Google Gemini fallback). It's a stateful conversational agent with character, memory, and autonomous decision-making capabilities. The bot operates primarily in Russian.

- **Node.js**: 18+ required
- **Package Type**: CommonJS
- **Entry Point**: `src/index.js`

## Commands

```bash
npm start          # Run the bot locally
npm install        # Install dependencies
```

### Production Deployment (PM2)
```bash
pm2 start src/index.js --name "sych-bot"
pm2 restart sych-bot
```

Auto-deployment triggers on push to `main` via GitHub Actions (`.github/workflows/deploy.yml`).

## Development Workflow

При любых изменениях:
1. Обновить версию в `package.json` (поле `"version"`)
2. **При добавлении новой функции** — обновить `/help` команду в `src/core/logic.js` (helpText)
3. **При важных изменениях** — обновить `README.md` и `CLAUDE.md` если затронута документируемая функциональность
4. Закоммитить и запушить в `main`:
   ```bash
   git add .
   git commit -m "описание изменений"
   git push origin main
   ```
5. GitHub Actions автоматически деплоит на сервер — бот пересобирается для тестирования

## Architecture

### Core Components

```
src/
├── index.js           # Bot initialization, polling, reminder ticker (60s interval)
├── config.js          # Environment config, API keys, model selection
├── core/
│   ├── logic.js       # Main message handler and decision logic
│   └── prompts.js     # System prompts and bot personality
├── services/
│   ├── ai.js          # Multi-provider AI service with fallback chain
│   └── storage.js     # JSON file-based persistence (debounced saves)
└── utils/
    ├── helpers.js     # Utility functions
    └── rich.js        # sendRichMessage helper (Bot API 10.1) + авто-фоллбэк
```

### Data Storage (`/data` directory)
- `db.json` - Chats, reminders, banned users
- `profiles.json` - User profiles (reputation, traits, interests)
- `chatProfiles.json` - Chat profiles (topic, facts, style)
- `instructions.json` - User-specific instructions

### Message Processing Flow

1. **index.js**: Receives Telegram message via polling
2. **logic.js**: `processMessage()` handles routing:
   - Ban check → Thread resolution → Admin presence check → Command detection
   - Private messages forward to admin
   - Group messages go through AI processing
3. **ai.js**: Multi-model response generation with search integration
4. **storage.js**: Persist updates to JSON files

### Hybrid AI Model Strategy

| Purpose | Model | Usage |
|---------|-------|-------|
| Logic/Analysis | `google/gemma-3-27b-it` | Context analysis, decide if response needed, emoji selection |
| Smart Responses | `google/gemini-3.7-flash` | Generate conversational replies |
| Fallback | `gemini-2.5-flash-lite` | Google Gemini native when quota exhausted |

**Fallback chain**: OpenRouter → Google Gemini (rotates through multiple keys) → Admin notification

### Search Providers (configurable via `SEARCH_PROVIDER` env var)
- Tavily (default, recommended)
- Perplexity (via OpenRouter)
- Google (via Gemini Tools)

**Tavily usage** (`@tavily/core`, **camelCase** options!): `search()` with `searchDepth:"advanced"`, `maxResults:5`, `chunksPerSource:3`, `includeAnswer:"advanced"`, plus `topic` (news/finance/general) + `timeRange` chosen per-query by the `shouldSearch` logic model for freshness. `ai.extractUrl()` reads a shared article URL via Tavily Extract (auto-triggered on a non-image link with read-intent).

YouTube-ссылки с явным запросом сначала обрабатываются по субтитрам. Бюджет расшифровки адаптивный: 6k символов для обзора, 12k для обычного пересказа, 25k для разбора и до `YOUTUBE_TRANSCRIPT_MAX_CHARS` только для явно полного запроса. Если субтитры недоступны или YouTube блокирует серверный IP, `src/services/youtube-gemini.js` передаёт публичный URL напрямую `gemini-3.5-flash-lite`, кэширует одинаковый нейтральный конспект и использует его как первичный источник для основного ответа. Tavily Search остаётся последним fallback. Стартовый таймкод применяется только при явной просьбе «с этого места»; все внешние вызовы ограничены таймаутами.

## Key Environment Variables

```
TELEGRAM_BOT_TOKEN     # From @BotFather
ADMIN_USER_ID          # Your Telegram ID (controls admin features)
AI_API_KEY             # OpenRouter API key
AI_BASE_URL            # Optional, defaults to OpenRouter
SEARCH_PROVIDER        # tavily | perplexity | google
TAVILY_API_KEY         # If using Tavily search
GOOGLE_GEMINI_API_KEY  # Required for fallback
GOOGLE_GEMINI_API_KEY_2 # Optional additional keys for rotation
YOUTUBE_GEMINI_MODEL   # Direct public YouTube fallback, default gemini-3.5-flash-lite
YOUTUBE_GEMINI_TIMEOUT_SECONDS # Per-attempt timeout, default 45
YOUTUBE_GEMINI_CACHE_HOURS # In-memory analysis cache, default 6
```

See `.env.example` for full configuration template.

## Profile System (User Memory)

Бот запоминает информацию о пользователях в `profiles.json` (изолировано по чатам).

**Поля профиля:** `realName`, `facts`, `attitude`, `relationship` (0-100), `location`

**Два механизма обновления:**
- **Batch (Наблюдатель)**: каждые 20 сообщений анализирует всех участников
- **Immediate (Рефлекс)**: после каждого ответа бота анализирует собеседника

**Правила репутации:**
- Позитив к боту: +1..+3 (копить сложно)
- Негатив к боту: -5..-10 (терять легко)
- Конфликты с другими пользователями НЕ влияют на репутацию
- Валидация в коде: `storage.js` → `_applyProfileUpdates()`

## Chat Profile System (Chat Context)

Бот запоминает информацию о чатах в `chatProfiles.json`.

**Поля профиля чата:** `topic`, `facts`, `style`, `lastUpdated`

**Механизмы обновления:**
- **Batch**: каждые 50 сообщений анализирует тему и факты чата
- **Инициализация**: при пустом профиле и наличии 10+ сообщений в истории
- **Ручная команда**: `Сыч, этот чат про [описание]`

**Лимиты:**
- `topic`: до 200 символов (1-2 предложения)
- `facts`: до 500 символов (накопленные факты)

**Использование:** контекст чата передаётся в каждый запрос AI (~100 токенов).

## Voice transcription and summaries

`transcribeAudio()` returns only `{text}`. `logic.js` combines caption and transcription, then re-evaluates `config.triggerRegex` and reply-to-bot routing. An addressed voice follows the same natural-language commands, reminders, context, search and personality path as text, without a transcript card or summary call. A non-addressed voice calls `summarizeVoiceTranscript()` as needed and sends the usual card. Muted topics are checked before recognition and again after awaits. Slash commands are only read from the original message/caption, never executed from speech.

`transcribeAudio()` uses a dedicated native Gemini model with neutral transcription instructions, JSON schema `{text: string}`, and no Sych personality or search tools. Up to 700 characters, no summary request is made. Longer transcripts go to a separate neutral summary model with `{summary: string}`; the full transcript is the only source. Preserve questions, requests, names, numbers, deadlines, negations, uncertainty and conditions; never force everything into one sentence. Empty, invalid, over-600-character or less-than-2x-compressed summaries are discarded, never truncated. Summary processing has a 20-second total deadline and must not discard a successful transcript on failure. Key rotation recreates both voice models. `src/utils/voice.js` owns parsing/length policy, `formatVoiceMessage()` in `rich.js` produces one escaped card with the transcript expanded or under disclosure. Chat context always receives the full transcription. Covered by `test/voice.test.js`.

## Reminder intent and delivery

`ai.parseReminder()` classifies `answer_now`, `schedule`, `clarify`, or `cancel` with a 20-second deadline. `src/utils/reminders.js` validates literal time quotations from the request or replied announcement and computes dates deterministically; model-generated ISO timestamps or confirmations are never trusted. Do not add an arbitrary default clock. The announcement's original/forward date anchors relative expressions. One-time reminders support explicit dates/weekdays, relative durations and spoken Russian numbers; default UTC+5, explicit MSK and UTC/GMT offsets. Unresolved, past, recurring or ambiguous requests ask for clarification. An informational question goes to the ordinary response pipeline.

`PendingReminders` binds a clarification to the sender, chat, topic, business connection and exact bot prompt message ID, with a 30-minute in-memory TTL. It retains the initial subject, announcement and source message across replies; replies consume the pending entry before awaiting the model. `sendRich()` returns `messageId` for rich and legacy delivery. Restart loses unfinished clarifications; `/forget` removes them. Saved reminders retain `threadId`, `businessId`, and `sourceMessageId` (older records may omit these). Confirmation comes from the validated saved time. `reminder-delivery.js` prevents concurrent duplicate sends and removes a task only after successful delivery; failures remain queued. `index.js` invokes it every 60 seconds. An ambiguous network timeout can still cause a repeated delivery; Telegram does not provide idempotency keys.

Tests: `reminders.test.js`, `conversation-routing.test.js`, `rich-message-id.test.js`. Optional `scripts/test-conversation-live.js` uses real AI with an isolated `SYCH_DATA_DIR`; `--telegram` additionally uses real admin-only Telegram delivery and synthetic input updates, without production polling. Audio fixtures and all reports belong in ignored `test-output/`, never commit user data or credentials.

## Image Memory (Vision Context)

Когда бот реально смотрит на изображение (его позвали по фото/стикеру/картинке-ссылке или реплаем на них), после ответа он **асинхронно** получает **подробное** нейтральное описание картинки (абзац-полтора, потолок `config.imageDescMaxChars`, дефолт 1500 символов) дешёвой нативной моделью (`describeModel` на `gemini-2.5-flash-lite`, без характера Сыча и без поиска) и **вшивает его прямо в запись истории этого сообщения** (`[🖼 на картинке: ...]`). Промпт описания (`prompts.describeImage()`) намеренно универсальный — без перечня типов деталей; единственный жёсткий запрет — выдумывать то, чего не видно.

- **Зачем:** описание едет в окне контекста (последние 30 сообщений), поэтому по картинке можно спрашивать дальше (цвет, что на фоне, текст со скрина) — модель отвечает из текста, **не отправляя картинку в нейронку повторно**.
- **Экономия (lazy, Tier 1):** описывается только та картинка, которую бот реально трогал; игнорируемые мемы не стоят ничего. Вызов идёт в фоне на бесплатных ротируемых Google-ключах — на скорость ответа не влияет.
- **Фоллбэк на пиксели:** если описание упустило деталь или бот ошибся — реплай прямо на саму картинку заставляет пересмотреть пиксели заново (`reply_to_message.photo` → новый vision-вызов) и обновляет память.
- **Затухание:** память живёт, пока картинка в окне из 30 сообщений, дальше забывается сама.

Код: `ai.describeImage()` + `describeModel` (`src/services/ai.js`), `prompts.describeImage()`, вызов в `processMessage` (`src/core/logic.js`); `addToHistory()` теперь возвращает запись, чтобы её дообогатить описанием.

## Design Decisions

- **Rich Messages**: All outgoing messages go through `sendRich()` (`src/utils/rich.js`) → Telegram `sendRichMessage` (Bot API 10.1), with auto-fallback to plain `sendMessage`. Convention: short replies = plain markdown; long AI answers = markdown field (model formats freely); showcase/system/admin = handcrafted HTML (escape dynamic parts with `escapeHtml`). `sendRichMessage` is called via raw HTTP (axios `proxy:false`), as `node-telegram-bot-api` doesn't support it yet. AI replies use the markdown field directly (native tables/lists — prettier than HTML); `normalizeMd` guarantees a blank line before tables. The AI may embed images via `![](url)` using real URLs from Tavily search (`include_images`), and multiple images as a `<tg-collage>`; `sendRich` retries without images/collage if Telegram rejects the media (then falls back to plain text). Stats = markdown table; sources = inline links + collapsible `<details>Источники</details>`; AI palette also includes `==highlight==`, `||spoiler||` and checklists. NB: time entities `tg://time` do NOT render — don't use them.
- **Admin-only groups**: Bot auto-leaves groups where admin isn't a member
- **No database**: JSON file persistence with 5-second debounced saves
- **Graceful shutdown**: SIGINT handler saves all data before exit
- **History limit**: Keeps last 30 messages per chat
- **Profile updates queue**: Prevents race condition between Batch and Immediate
- **Bot trigger pattern**: `/(?<![а-яёa-z])(сыч|sych)(?![а-яёa-z])/i`
- **Timezone**: Yekaterinburg UTC+5 for time-aware responses

## Bot Commands (in-chat)

Slash commands require an explicit recipient matching the bot's actual `getMe().username` (cached per bot instance): `/mute@Siitch_bot`, `/start@Siitch_bot`, etc. Bare commands and commands for other bots are ignored before media, memory, or AI processing, including in private/business chats, captions, and replies. Matching is case-insensitive. `src/utils/commands.js` owns recipient validation; `src/core/logic.js` applies it before command handling. Natural-language triggers remain unchanged. All slash commands listed below require the `@bot_username` suffix.

- `/start` - Bot info
- `/ban [username]` - Ban user (admin only)
- `/unban [ID]` - Restore user (admin only)
- `Сыч напомни [текст]` - Set reminder
- `Сыч кто я?` - Show user profile
- `Сыч расскажи про @username` / `Сыч расскажи про TGID` - Show a participant profile by username or exact Telegram user ID within the current chat
- `Сыч стата` - Show token usage statistics
- `Сыч, этот чат про [тема]` - Set chat topic manually
