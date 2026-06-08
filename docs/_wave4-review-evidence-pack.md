## daily-ingest.ts alert sender (lines 180-210)
      signal: context.signal,
      stdio: 'inherit',
      killProcessGroup: true,
    })
  } catch (err) {
    throw new Error(`${stage.name} failed: ${errorMessage(err)}`)
  }
}

export async function sendDiscordAlert(message: string): Promise<void> {
  await spawnAndWait('python3', [NOTIFY_SCRIPT, '--send', message, '--channel', 'discord'], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: 'inherit',
    killProcessGroup: false,
  })
}

function resolveConfig(config: RunDailyIngestOptions['config'] = {}): DailyIngestConfig {
  const env = config.env ?? process.env
  return {
    reserve: normalizePositiveInt(config.reserve ?? numberFromEnv(env.SIFTLY_DAILY_CREDIT_RESERVE), DEFAULT_CREDIT_RESERVE),
    ingestMaxPages: normalizePositiveInt(config.ingestMaxPages ?? numberFromEnv(env.SIFTLY_DAILY_INGEST_MAX_PAGES), DEFAULT_INGEST_MAX_PAGES),
    pageSize: normalizePositiveInt(config.pageSize ?? numberFromEnv(env.SIFTLY_DAILY_PAGE_SIZE), DEFAULT_PAGE_SIZE),
    stageLimit: normalizePositiveInt(config.stageLimit ?? numberFromEnv(env.SIFTLY_DAILY_STAGE_LIMIT), DEFAULT_STAGE_LIMIT),
    wallBudgetMs: normalizePositiveInt(config.wallBudgetMs ?? numberFromEnv(env.SIFTLY_DAILY_WALL_BUDGET_MS), DEFAULT_WALL_BUDGET_MS),
    cwd: config.cwd ?? REPO_ROOT,
    env,
  }
}


## buildDailyIngestStages
  }
}

export function buildDailyIngestStages(config: Partial<DailyIngestConfig> = {}): DailyIngestStageCommand[] {
  const ingestMaxPages = normalizePositiveInt(config.ingestMaxPages, DEFAULT_INGEST_MAX_PAGES)
  const pageSize = normalizePositiveInt(config.pageSize, DEFAULT_PAGE_SIZE)
  const stageLimit = normalizePositiveInt(config.stageLimit, DEFAULT_STAGE_LIMIT)

  return [
    {
      name: 'ingest',
      command: 'npx',
      args: ['tsx', 'scripts/ingest.ts', '--incremental', '--max-pages', String(ingestMaxPages), '--page-size', String(pageSize)],
    },
    {
      name: 'enrich',
      command: 'npx',
      args: ['tsx', 'scripts/enrich.ts', '--limit', String(stageLimit)],
    },
    {
      name: 'embed',
      command: 'npx',
      args: ['tsx', 'scripts/embed.ts', '--limit', String(stageLimit)],
    },
    {
      name: 'export',
      command: 'npx',
      args: ['tsx', 'scripts/export-obsidian.ts', '--limit', String(stageLimit)],
    },
  ]
}

export async function runDailyIngest(options: RunDailyIngestOptions = {}): Promise<DailyIngestResult> {

## notify.py _send + main (220-260)
        message:    Text. Discord markdown (**bold**, *italic*, `code`).
                    Auto-converted to Telegram HTML when sending to Telegram.
        channel:    "telegram" | "discord" | "all".
        target:     Optional override channel_id (discord) or chat_id (telegram).
        thread_id:  Optional Discord thread ID override.

    Returns True if at least one channel succeeded.
    """
    success = False
    if channel in ("telegram", "all"):
        if _send_telegram(message, chat_id=target if channel == "telegram" else None):
            success = True
    if channel in ("discord", "all"):
        if _send_discord(
            message,
            channel_id=target if channel == "discord" else None,
            thread_id=thread_id,
        ):
            success = True
    return success


# ── CLI ──────────────────────────────────────────────────────────────────────


def _main() -> int:
    p = argparse.ArgumentParser(description="Hermes notify — out-of-agent alerts")
    p.add_argument("--send", help="Message to send")
    p.add_argument("--channel", default="telegram", choices=["telegram", "discord", "all"])
    p.add_argument("--target", help="Override channel_id / chat_id")
    p.add_argument("--thread-id", dest="thread_id", help="Discord thread ID override")
    p.add_argument("--profile", help="Hermes profile whose .env (tokens + home channels) to use, e.g. 'aegis'. Defaults to HERMES_HOME/HERMES_PROFILE env, else 'default'.")
    p.add_argument("--test", action="store_true", help="Send a test message to all channels")
    args = p.parse_args()

    # --profile overrides env-based resolution; re-point the env path + clear cache.
    if args.profile:
        global _ENV_PATH, _ENV_CACHE
        os.environ["HERMES_PROFILE"] = args.profile
        os.environ.pop("HERMES_HOME", None)  # explicit --profile wins over inherited HERMES_HOME
        _ENV_PATH = _resolve_env_path()
