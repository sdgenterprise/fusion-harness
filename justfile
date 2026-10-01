set dotenv-load := true

# Bare `just` lists every recipe (first recipe = default — keep this one on top).
default:
    @just --list

# fusion-harness — 2-5 configured agents, AND not OR.
WORKHORSE_ARCHITECT := "anthropic/claude-sonnet-5"
WORKHORSE_BUILDER := "openai/gpt-5.6-terra"
SOTA_ARCHITECT := "anthropic/claude-fable-5"
SOTA_BUILDER := "openai/gpt-5.6-sol"

# Cheap legacy two-slot pair. Raw chat is the builder.
fh-workhorse *ARGS:
    pi -e extensions/fusion-harness/fusion-harness.ts \
        --model {{WORKHORSE_BUILDER}} \
        --architect {{WORKHORSE_ARCHITECT}} --builder {{WORKHORSE_BUILDER}} \
        --architect-thinking medium --builder-thinking medium \
        {{ARGS}}

# Frontier legacy two-slot pair.
fh-sota *ARGS:
    pi -e extensions/fusion-harness/fusion-harness.ts \
        --model {{SOTA_BUILDER}} \
        --architect {{SOTA_ARCHITECT}} --builder {{SOTA_BUILDER}} \
        --architect-thinking medium --builder-thinking medium \
        {{ARGS}}

# Explicit 2-5 slot YAML stack. The extension selects configured Main as host.
fh-stack CONFIG *ARGS:
    pi -e extensions/fusion-harness/fusion-harness.ts \
        --fh-config {{CONFIG}} {{ARGS}}

# THE fusion stack: rune=Fable 5 architect · flux=Gemini 3.7 Flash Main · drift=DeepSeek V4 Pro
fusion *ARGS:
    just fh-stack .pi/fusion-harness/model-stack-fusion.yaml {{ARGS}}

# 5-slot fusion stack: fusion trio + fire=Kimi K3 + hawk=DeepSeek V4 Flash (both Fireworks)
fusion5 *ARGS:
    just fh-stack .pi/fusion-harness/model-stack-fusion-5.yaml {{ARGS}}

# Direct-API stack: DeepSeek V4.1 Flash architect · Kimi K3 Main · GPT-6.1 Sol via OpenRouter.
# Needs DEEPSEEK_API_KEY, MOONSHOT_API_KEY, OPENROUTER_API_KEY in .env.
direct *ARGS:
    just fh-stack .pi/fusion-harness/model-stack-direct.yaml {{ARGS}}

# ── fusion + self-compact (+ jev) ────────────────────────────
# The Main builder (raw-chat host) manages its own context: notice/warning guidance,
# a note_to_self handoff, and a forced cutoff. Load order matters: fusion-harness first
# (clears pi's default footer), jev in the middle (its cut-point pick must mutate the
# compaction event BEFORE self-compact reads it), self-compact last (its context gauge
# owns the footer). Clean-room children always spawn with --no-extensions and never see Jev.
SC_EXT := "../self-compact-pi-agent/apps/self-compact/extensions/self-compact/self-compact.ts"
JEV_EXT := "extensions/jev/jev.ts"

# Threshold overrides (e.g. `just soft=5% warn=8% buffer=2% fusion-compact`). Empty = self-compact
# defaults (notice 10%, warning 20%, hard cutoff 30% of the live model window).
soft := ""
warn := ""
buffer := ""

# The fusion stack with a self-compacting, jev-guarded host. Extra args go to pi.
fusion-compact *ARGS:
    pi -e extensions/fusion-harness/fusion-harness.ts \
        -e {{JEV_EXT}} \
        -e {{SC_EXT}} \
        --fh-config .pi/fusion-harness/model-stack-fusion.yaml \
        {{ if soft != "" { "--compact-soft-at " + soft } else { "" } }} \
        {{ if warn != "" { "--compact-at " + warn } else { "" } }} \
        {{ if buffer != "" { "--compact-buffer " + buffer } else { "" } }} \
        {{ARGS}}

# Any explicit 2-5 slot YAML stack with a self-compacting, jev-guarded host.
fh-stack-compact CONFIG *ARGS:
    pi -e extensions/fusion-harness/fusion-harness.ts \
        -e {{JEV_EXT}} \
        -e {{SC_EXT}} \
        --fh-config {{CONFIG}} \
        {{ if soft != "" { "--compact-soft-at " + soft } else { "" } }} \
        {{ if warn != "" { "--compact-at " + warn } else { "" } }} \
        {{ if buffer != "" { "--compact-buffer " + buffer } else { "" } }} \
        {{ARGS}}

# The direct-API stack with a self-compacting host (Kimi K3 Main manages its own context).
direct-compact *ARGS:
    just fh-stack-compact .pi/fusion-harness/model-stack-direct.yaml {{ARGS}}

# Composition smoke test: both extensions in one pi process, scripted model, zero API cost.
compose-test:
    node --test --test-concurrency=1 extensions/fusion-harness/tests-compose/self-compact-compose.test.ts

# jev extension unit tests (decision logic + mock backend, offline).
jev-test:
    node --test "extensions/jev/tests/*.test.ts"
