---
name: local-llm-inference-planning
description: Plan hardware, topology, runtime, cost, and concurrency for running large local/open-weight LLMs such as Qwen, DeepSeek, or Llama, using verified current model specs and benchmarks instead of invented VRAM, throughput, or pricing numbers.
---

# Local LLM Inference Planning

## Setup
- Use this when the user asks what GPU/server setup is needed for a named open-weight model, how many users a model server can support, whether to rent/buy hardware, or how to size VRAM/topology/KV cache.
- Follow the named-reference rule: search current authoritative sources before describing a named model, provider, benchmark, GPU SKU, or rental price.
- Preferred sources:
  - Official model card / GitHub / docs for parameter count, active parameters, context length, quantized releases, and supported runtimes.
  - Inference framework docs for vLLM, SGLang, TensorRT-LLM, llama.cpp, Ollama, LM Studio, MLX, or KTransformers support.
  - Cloud/rental provider pages for current GPU pricing.
  - Benchmark reports that state model, quantization, hardware, framework, input/output lengths, concurrency, and latency.
- Do not invent exact throughput, prices, context support, or memory requirements. If an estimate is necessary, label it as an estimate and show assumptions.

## Workflow

### 1. Clarify the target workload
Identify:
- Model and variant: e.g. Qwen3-235B-A22B, Qwen3-Coder-480B-A35B, DeepSeek-V4-Pro, Llama 70B.
- Purpose: personal chat, coding agent, API for many users, batch jobs, long-context retrieval, or fine-tuning.
- Latency target: interactive streaming, background batch, or premium slow reasoning.
- Context length: ordinary 4–32k, repo-scale 128–256k, or extreme 1M.
- Budget preference: buy workstation/server, rent hourly, or use hosted API.

If the user asks for “best setup,” give a default recommendation and explain tiers.

### 2. Verify current model facts
Search/fetch authoritative sources for:
- Total parameters and active parameters for MoE models.
- Native and extrapolated context length.
- Released precision/quantization formats: BF16, FP8, INT8, AWQ/GPTQ/GGUF, NVFP4, etc.
- Recommended frameworks and minimum versions.
- Official or credible benchmark links.

Example findings pattern:
- Qwen3-235B-A22B: MoE with ~235B total and ~22B active parameters; verify model card for exact variant and runtime support.
- Qwen3-Coder-480B-A35B: MoE with ~480B total and ~35B active; verify context length and FP8/quantized availability.

### 3. Estimate memory conservatively
Separate the components:
- **Weights memory:** roughly `parameters × bytes_per_parameter`, plus framework overhead.
- **KV cache:** scales with concurrent sequences, context length, layers/heads, precision, and framework; long context can dominate user capacity.
- **Activation/runtime overhead:** reserve headroom for kernels, CUDA graphs, batching, fragmentation, tokenizer/server processes.

Rules of thumb:
- Do not size to exact weight bytes only; leave headroom.
- MoE active parameters affect compute per token, but total parameters still matter for weight residency unless using specialized offload/sharding.
- 1M-token contexts are a different class from 8k chat; treat them as capacity reducers even on very large GPU nodes.

### 4. Choose topology, not just GPU count
For large models, recommend topologies by need:
- **Single high-VRAM GPU** (RTX 6000 Ada/Blackwell, A6000, H100/H200/GB200 class): simpler for 7B–70B quantized models and low concurrency.
- **Single-node 4–8 GPU NVLink/SXM/HGX/NVL**: preferred for very large dense/MoE models where tensor/expert parallelism needs fast GPU-GPU communication.
- **Multi-node clusters**: only when the framework and workload justify network complexity; require high-speed interconnect and careful serving design.

Flag weak setups:
- Random separate PCIe rental pods without fast interconnect may fit weights but serve poorly.
- Consumer multi-GPU rigs can be economical but often suffer from VRAM, power, cooling, and interconnect limits.

### 5. Match runtime to model and hardware
Common choices:
- **vLLM**: strong OpenAI-compatible serving, paged attention, batching; verify exact model support/version.
- **SGLang**: strong for structured/agent workloads and high-throughput serving; verify model support.
- **TensorRT-LLM / NVIDIA NIM**: optimized NVIDIA deployments; useful for Hopper/Blackwell/HGX/NVL but version-sensitive.
- **llama.cpp/Ollama/LM Studio**: good for smaller/quantized local models, but may not be ideal for huge MoE production serving.
- **KTransformers/MLX**: useful for specialized/offload or Apple Silicon cases; verify maturity.

### 6. Estimate concurrency from throughput
Use the formula:

```text
active_users ≈ sustained_output_tokens_per_second / desired_tokens_per_second_per_user
```

Then adjust down for:
- Long prompts and long context prefill latency.
- Heavy reasoning outputs.
- Tool/agent workloads with many turns.
- Higher per-user streaming targets.
- KV cache limits and batching inefficiency.

Example framing:
- Short chat can support many more active users than long-context coding agents.
- “Active generating users” is not the same as logged-in users; casual users are mostly idle.
- For premium huge models, use them as a fallback/premium lane and route ordinary requests to a smaller or faster model.

### 7. Price the setup
For rentals:
- Fetch current price per GPU-hour and storage/egress assumptions.
- Compute hourly, daily, weekly, and monthly costs:

```text
total_hourly = gpu_count × price_per_gpu_hour
monthly_720h = total_hourly × 720
active_user_hour = total_hourly / active_generating_users
```

For purchases:
- Include GPU cost, host chassis, CPU/RAM, storage, PSU, cooling/noise, electricity, depreciation, and maintenance.
- Compare against hosted API costs if usage is bursty.

## Response template

```markdown
## Short answer
For [model/workload], I’d use [recommended topology]. If this is just experimentation, rent [rental tier] first.

## Verified model facts
- Source: ...
- Params/context/quantization/runtime: ...

## Hardware tiers
1. Minimum experiment: ...
2. Comfortable personal/server: ...
3. Production/premium: ...

## Concurrency estimate
Assumptions: [output tok/s], [desired tok/s/user], [context]
- Short chat: ... active users
- Coding agents: ... active users
- Long context: ... active users

## Cost
- Hourly: ...
- Day/week/month: ...
- Cost per active user-hour: ...

## Caveats
- Benchmarks depend on input/output lengths, quantization, framework version, and batching.
```

## Validation checklist
- Did you verify the named model/SKU/provider with current sources?
- Did you distinguish total vs active parameters for MoE models?
- Did you separate weight memory from KV cache and runtime overhead?
- Did you discuss topology/interconnect, not just aggregate VRAM?
- Did you label estimates and show formulas?
- Did you avoid invented numeric specs?
