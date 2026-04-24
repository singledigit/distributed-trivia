# Trivia Game

A real-time multiplayer trivia game built with AWS AppSync Events, Lambda Durable Functions, and Vue.js. A host creates a session, players join via QR code, answer questions at their own pace, and compete on a live leaderboard.

All communication flows through AppSync Events (WebSocket) — no API Gateway.

## Architecture

```mermaid
graph TD
    Admin["Admin UI"] --> AppSync["AppSync Events"]
    Player["Player UI"] --> AppSync
    Leaderboard["Leaderboard UI"] --> AppSync

    AppSync --> SH["Session Handler"]
    AppSync --> PM["Participant Manager"]

    SH -->|async| ODF["Session Orchestrator<br/>(Durable Function)"]
    PM -->|async| POD["Participant Orchestrator<br/>(Durable Function)"]
    ODF -->|callback| POD

    SH --> DDB[("DynamoDB")]
    ODF --> DDB
    POD --> DDB

    DDB -->|Streams| STR["Stream Handler"]
    STR --> AppSync
    ODF --> AppSync
    POD --> AppSync
```

### Lambda Functions

| Function | Type | Purpose |
|----------|------|---------|
| **Session Handler** | Standard | Admin commands (create, start, cancel, categories), state reconstruction on subscribe |
| **Participant Manager** | Standard | Player join, routes answer/skip/ready callbacks to PODs |
| **Session Orchestrator (ODF)** | Durable | Game lifecycle: create session, build question package, start, timer/cancel, end |
| **Participant Orchestrator (POD)** | Durable | Per-player: question delivery, scoring, activity logging, timeout handling |
| **Stream Handler** | Standard | DDB Streams → leaderboard updates (player joins, score changes, completions) |

### AppSync Events Channels

| Channel | Purpose |
|---------|---------|
| `admin/{sessionId}` | Host commands and state restore |
| `leaderboard/{sessionId}` | Score/status updates from stream handler |
| `player/{sessionId}/{participantId}` | Individual gameplay |
| `game/{sessionId}` | Broadcast events (started, times up, cancel) |

## Prerequisites

- [AWS CLI](https://aws.amazon.com/cli/) configured with a profile
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) v1.153+
- Node.js 22+
- An AWS account with permissions for Lambda, DynamoDB, AppSync, IAM, CloudWatch

## Setup

### 1. Deploy the backend

```bash
# Build and deploy
sam build
sam deploy --guided
```

On first deploy, SAM will prompt for configuration. The defaults in `samconfig.toml` use:
- Stack name: `trivia`
- Region: `us-west-2`
- Profile: `demo`

Note the outputs — you'll need the AppSync endpoints and API key.

### 2. Seed the question database

```bash
cd scripts
npm install
npx tsx seed.ts
```

This creates two categories (Science & Nature, Pop Culture) with 30 questions each.

### 3. Set up the frontend

```bash
cd frontend
npm install
cp .env.example .env
```

Edit `.env` with the values from `sam deploy` outputs:

```
VITE_APPSYNC_HTTP_ENDPOINT=https://YOUR_API_ID.appsync-api.us-west-2.amazonaws.com/event
VITE_APPSYNC_REALTIME_ENDPOINT=wss://YOUR_API_ID.appsync-realtime-api.us-west-2.amazonaws.com/event/realtime
VITE_APPSYNC_API_KEY=your-api-key-here
```

### 4. Run locally

```bash
cd frontend
npm run dev
```

Open `http://localhost:5173/controller` to create a game.

## Development

### Iterating on Lambda code

Use `sam sync` for fast deploys during development:

```bash
sam sync --watch
```

This watches for file changes and deploys automatically. Durable function changes require a new version (CloudFormation update), which `sam sync` handles.

### Managing durable executions

During development, you may need to stop running durable executions:

```bash
# List and stop via SAM CLI
sam remote execution stop <execution-arn>
```

## Game Flow

1. **Host** opens `/controller`, selects category and mode, creates session
2. **Players** scan QR code → `/play/{sessionId}`, enter display name, join
3. **Host** clicks Start → synchronized 5-second countdown on all screens
4. **Players** answer questions at their own pace (30s per question, skip/more time options)
5. **Leaderboard** (`/leaderboard/{sessionId}`) shows real-time scores and progress
6. **Game ends** when timer expires (timed mode) or host cancels

### Game Modes

| Mode | Description |
|------|-------------|
| **Timed** | 1–5 minutes. All players answer as many questions as they can before time runs out. |
| **Question Count** | 1–30 questions. Game ends when all players finish or 5-minute hard cap. |

### Scoring

| Difficulty | Points (correct) | Points (incorrect/skip) |
|-----------|------------------|------------------------|
| Easy | 10 | 0 |
| Medium | 20 | 0 |
| Hard | 30 | 0 |

## Project Structure

```
trivia/
├── template.yaml              # SAM template — all AWS resources
├── samconfig.toml              # SAM deploy configuration
├── functions/
│   ├── session-handler/        # Admin commands + state reconstruction
│   ├── participant-manager/    # Player join + callback routing
│   ├── session-orchestrator/   # Game lifecycle (durable function)
│   ├── participant-orchestrator/ # Per-player gameplay (durable function)
│   └── stream-handler/         # DDB Streams → leaderboard updates
├── frontend/
│   ├── src/
│   │   ├── views/
│   │   │   ├── AdminView.vue       # Host controller
│   │   │   ├── PlayerView.vue      # Player game UI
│   │   │   ├── LeaderboardView.vue # Live scoreboard
│   │   │   └── NotFoundView.vue
│   │   ├── appsync-events.ts   # WebSocket client
│   │   ├── router.ts
│   │   └── main.ts
│   └── .env.example
└── scripts/
    └── seed.ts                 # Seed QuestionsTable
```

Each Lambda function is fully self-contained with its own dependencies. Shared utilities are copied into each function's `shared/` directory and bundled by esbuild.

## Key Design Decisions

- **All-WebSocket**: No API Gateway. All client-server communication through AppSync Events.
- **Durable Functions**: Game and player orchestration use Lambda Durable Functions for reliable state management across long-running game sessions.
- **DDB Streams for leaderboard**: PODs write to DynamoDB, Stream Handler computes and broadcasts leaderboard updates. Clean separation of concerns.
- **Self-contained functions**: Each Lambda bundles all its dependencies (including AWS SDK) — no layers, no shared external imports.
- **waitForCallback for game timer**: The ODF uses `waitForCallback` with a timeout equal to the game duration. Timeout = natural end. Callback = host cancel. One mechanism for both.

## Tech Stack

- **Frontend**: Vue.js 3, TypeScript, Vite, Vue Router
- **Backend**: AWS Lambda (Node.js 22, ARM64), TypeScript, esbuild
- **Orchestration**: AWS Lambda Durable Functions
- **Real-time**: AWS AppSync Events (WebSocket pub/sub)
- **Database**: Amazon DynamoDB (two tables, streams enabled)
- **IaC**: AWS SAM
