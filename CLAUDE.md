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
2. Закоммитить и запушить в `main`:
   ```bash
   git add .
   git commit -m "описание изменений"
   git push origin main
   ```
3. GitHub Actions автоматически деплоит на сервер — бот пересобирается для тестирования

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
    └── helpers.js     # Utility functions
```

### Data Storage (`/data` directory)
- `db.json` - Chats, reminders, banned users
- `profiles.json` - User profiles (reputation, traits, interests)
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
| Smart Responses | `google/gemini-3-flash-preview` | Generate conversational replies |
| Fallback | `gemini-2.5-flash-lite` | Google Gemini native when quota exhausted |

**Fallback chain**: OpenRouter → Google Gemini (rotates through multiple keys) → Admin notification

### Search Providers (configurable via `SEARCH_PROVIDER` env var)
- Tavily (default, recommended)
- Perplexity (via OpenRouter)
- Google (via Gemini Tools)

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
```

See `.env.example` for full configuration template.

## Design Decisions

- **Admin-only groups**: Bot auto-leaves groups where admin isn't a member
- **No database**: JSON file persistence with 5-second debounced saves
- **Graceful shutdown**: SIGINT handler saves all data before exit
- **History limit**: Keeps last 30 messages per chat
- **Bot trigger pattern**: `/(?<![а-яёa-z])(сыч|sych)(?![а-яёa-z])/i`
- **Timezone**: Yekaterinburg UTC+5 for time-aware responses

## Bot Commands (in-chat)

- `/start` - Bot info
- `/ban [username]` - Ban user (admin only)
- `/unban [ID]` - Restore user (admin only)
- `Сыч напомни [текст]` - Set reminder
- `Сыч кто я?` - Show user profile
- `Сыч стата` - Show token usage statistics
