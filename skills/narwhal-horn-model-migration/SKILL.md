---
name: narwhal-horn-model-migration
description: Upgrade the GGUF model served by Clemente's Narwhal-Horn Strix Halo host and align its Pi provider across The-Sceptre, Frost-Walrus, Narwhal-Horn, and Tribe-Mac. Use for model/quantization changes, llama.cpp compatibility upgrades, context-window sizing, reversible deployment, and four-host validation without exposing keys or overwriting host-specific Pi state.
---

# Narwhal-Horn Model Migration

Upgrade Narwhal-Horn as a serving system, not just a model file. Keep the previous server binary, launch configuration, GGUF, and client registration recoverable until the new model has passed live inference and context tests from every reachable client host.

## Boundaries

- Verify named models, quantizations, runtime support, and context claims from current official model cards and runtime documentation. Treat community configurations as evidence to test, not guarantees.
- Never read or print API keys, secret env files, private keys, cookies, auth stores, or protected Pi/Wayang state. It is sufficient to verify that a key path exists with restrictive permissions or that an authenticated request succeeds.
- Do not delete the old model during migration. Keep it as rollback material until Clemente explicitly approves cleanup; use recoverable deletion when cleanup is authorized.
- Back up each file or unit before replacing it. Do not overwrite dirty repository work; use a dedicated task branch/worktree and coordinate with active sessions.
- Use `sudo_exec` and the sudo skill for root-owned service changes. User services and user-owned files should remain user-owned.
- A Pi provider's `contextWindow` is a client claim, not a server setting. Advertise only a context size the live server actually accepts and passes.

## 1. Establish the migration manifest

Record non-secret facts before changing anything:

| Item | Required evidence |
|---|---|
| Source model | Exact Hugging Face repository, revision, license, architecture, native context, and supported runtimes |
| Quantization | Exact filename, byte size, tensor/quant type, and any separate vision/MTP projector files |
| Narwhal-Horn hardware | Total/available RAM, configured UMA/VRAM if relevant, free disk, GPU/backend, and competing memory users |
| Runtime | llama.cpp/fork repository, commit or build version, backend flags, server binary, bind/port, and service owner |
| Current serving state | Model id from `/v1/models`, launch arguments, context/parallel slots, cache types, and simple inference result |
| Client registrations | Provider source and installed copy on The-Sceptre, Frost-Walrus, Narwhal-Horn, and Tribe-Mac |
| Consumers | Pi/Wayang, Ruminant or other gateways, and any direct callers that depend on the old model id |
| Rollback | Previous binary, model, launch config/unit, provider extension, and exact restoration action |

If direct SSH or protected configuration access is denied, do not bypass it. Complete public research and source changes, then request a metadata-only authorized host inventory or provide a bounded human handoff.

## 2. Choose quantization and context from memory evidence

Separate memory into:

```text
peak_required = model_weights
              + recurrent/state cache
              + KV cache per token × context × parallel slots
              + compute graph/batch buffers
              + vision/MTP auxiliaries
              + runtime/OS headroom
```

For hybrid architectures such as Qwen3.5/Qwen3.6/Qwen3.8, do not estimate context solely from ordinary Transformer KV-cache formulas. Measure the runtime's reported allocations and peak resident memory because recurrent/SSM state, MTP, cache quantization, and backend placement materially change the result.

Selection policy:

1. Prefer the highest-quality quant that leaves at least 15–20% of physical memory available at the intended context under a representative prompt.
2. Keep parallel slots at one unless concurrency is explicitly needed; context allocation is often divided across slots.
3. Start with native context and default cache precision. Quantize K/V cache only when needed and validate quality.
4. Preserve enough output budget for reasoning and the final answer; do not set `maxTokens` equal to the entire context window.
5. Benchmark prompt processing, generation speed, peak memory, and coherence—not load success alone.

## 3. Treat extended context as a validation ladder

Use this order:

1. **Native context** — establish the reliable baseline.
2. **Intermediate extension** — normally 2× native context with the model author's documented scaling method.
3. **Maximum advertised extension** — only after intermediate context passes and memory remains safe.

For each tier:

- confirm the server reports the requested per-slot context rather than silently capping it;
- run a generated, non-private long prompt with unique facts near the beginning, middle, and end;
- test retrieval near the end of the window and a normal short task for regression;
- record peak RAM/VRAM, prompt-processing speed, decode speed, and server warnings;
- restart once and repeat a small smoke to prove settings persist.

Static YaRN can reduce short-context quality. Prefer the smallest scaling factor that meets real workloads. Never claim an extended context based only on model metadata or a startup log.

### Qwen3.8-specific note (verified 2026-08-19)

Official Qwen/Unsloth cards describe Qwen3.8-27B as a dense 27B vision-language model with 262,144 native context and extension up to 1,000,000 via YaRN. The official recipe uses original context 262,144, factor 2 for roughly 512K or factor 4 for roughly 1M, with RoPE theta 10,000,000 and Qwen's documented MRoPE sections.

Current llama.cpp support is release-sensitive. At the time of this note, Qwen3.5-family users reported a server-side context cap and an interaction with separately loaded vision projectors. Before using metadata overrides or patches:

- update/build a current Qwen3.8-capable llama.cpp in a separate path;
- inspect the GGUF metadata and current upstream issue status;
- test text-only and vision-enabled launches separately;
- prefer supported embedded metadata over ad hoc flags;
- do not carry a local llama.cpp patch forward without documenting it and validating it after upgrades.

A 128 GiB Strix Halo community configuration has demonstrated Q8-class Qwen3.8-27B at native 262K, but this is a starting hypothesis for Narwhal-Horn, not proof of its current free-memory headroom.

## 4. Stage the server upgrade reversibly

1. Create a timestamped migration directory or manifest outside the active model path.
2. Download to a staging path with resumable tooling. Pin the exact repository revision when possible and verify expected size/hash or Hugging Face LFS/Xet identity.
3. Build or install the required llama.cpp version beside the current binary. Record commit/build flags and backend; do not replace the known-good binary yet.
4. Launch the candidate on an alternate loopback/LAN-safe port with the intended model, one slot, native context, and no public exposure.
5. Validate:
   - `/v1/models` returns the expected id;
   - non-streaming and streaming chat complete;
   - thinking control and preserved reasoning behave as intended;
   - tool calls parse in Pi;
   - developer-role support matches the model/template;
   - image input works if the vision projector is intentionally enabled;
   - cancellation closes generation promptly if Ruminant depends on it.
6. Run the context ladder and record measurements.
7. Back up the active service/launcher, then switch its model path, context/cache flags, and runtime binary atomically.
8. Restart the owning service, inspect bounded logs, and rerun live API tests.

If the service fails, restore the previous launch config/binary/model and restart. A failed context tier should fall back to the last passing tier, not block the base model migration.

## 5. Update the canonical Pi provider

The canonical provider is normally the `narwhal-horn` extension in `~/src/mypi`, with an installed copy under `~/.pi/agent/extensions/`. Preserve its resilient endpoint discovery and secret-key path; change only model-specific metadata unless endpoint behavior also needs work.

Update and review:

- model `id` and human-readable `name`;
- quant/backend label;
- `reasoning` and text/image input capability;
- truthful `contextWindow` and conservative `maxTokens`;
- `thinkingFormat`, developer-role support, and max-token field compatibility;
- tests or validation scripts that refer to the old id.

Search for the old model id in non-secret source and docs. Gateways that transparently proxy `/v1/models` may need no code change, but hard-coded model ids do.

## 6. Roll out to four hosts

Targets:

- The-Sceptre
- Frost-Walrus
- Narwhal-Horn
- Tribe-Mac

For each host:

1. Coordinate with active work and identify platform/package ownership.
2. Back up the exact installed provider extension to a timestamped host-local path.
3. Install the reviewed canonical extension without copying Wren identity, scheduler authority, sessions, auth, settings, or unrelated host state.
4. Preserve host-specific endpoint overrides and secret files opaquely.
5. Validate the installed file hash against the canonical artifact when copies should be identical.
6. Run the host's public/offline model listing and confirm the old id is gone and the new id/context are present.
7. Run an end-to-end prompt through `narwhal-horn/<new-id>` when the host can reach Narwhal-Horn.
8. Use `/reload`, reconnect, or a new Pi session where required; do not rewrite the selected model of an active session silently.

On Tribe-Mac, coordinate with concurrent Wayang/Loom migration work and use macOS-safe paths/commands. Provider rollout must remain identity-neutral.

## 7. Final validation and evidence

The migration is complete only when:

- Narwhal-Horn serves the expected model after a service restart;
- the chosen context tier is reported by the server and passes long-context retrieval/coherence tests;
- peak memory retains the agreed safety margin;
- streaming, reasoning controls, tools, and intended vision support pass;
- Ruminant/direct consumers see the new model id or remain compatible;
- all four host registrations are updated, or each unreachable host has a precise non-secret blocker and handoff;
- the previous model/runtime/config remain recoverable;
- a project journal records sources, versions, quant, context, memory measurements, backup paths, validation results, and rollback steps.

Update Memoriki with the durable final topology after validation. Record operational facts and reusable lessons, never keys, prompts containing private data, or transient task chatter.
