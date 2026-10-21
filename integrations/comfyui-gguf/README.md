# Qwen-Image 2.1 GGUF integration (experimental)

Install [ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) at commit `6ea2651e7df66d7585f6ffee804b20e92fb38b8a` in your ComfyUI `custom_nodes` directory and install its requirements in the ComfyUI Python environment. The tested GGUF package version is 0.19.0.

Copy `tavern_qwen.py` from this directory into `custom_nodes/ComfyUI-GGUF/`. In that extension's `__init__.py`, immediately after `from .nodes import NODE_CLASS_MAPPINGS`, add:

```python
    from .tavern_qwen import TavernQwen21CLIPLoaderGGUF, TavernQwen21TextEncodeStaged
    NODE_CLASS_MAPPINGS["TavernQwen21CLIPLoaderGGUF"] = TavernQwen21CLIPLoaderGGUF
    NODE_CLASS_MAPPINGS["TavernQwen21TextEncodeStaged"] = TavernQwen21TextEncodeStaged
```

After confirming both image and chat generation are idle, restart ComfyUI and Studio. The current workflow selects `execution_device=cuda` and `TavernQwen21TextEncodeStaged`: encoding uses BF16 compute, then completely unloads models before sampling. Before the next encode it also unloads the previous denoiser. The native vision weights and Q8_0 language weights remain the same; nonquantized floating weights are cast to BF16 in memory. ComfyUI still offloads part of the encoder to CPU when it cannot fit in VRAM.

The loader defaults to CPU/FP32 for old workflow snapshots without `execution_device`. Keep dynamic VRAM, asynchronous offload and pinned memory disabled on the tested Windows installation. Do not enable GPU encoding with the ordinary encode node. See [measurements and limits](../../docs/GPU分阶段优化.md).

Required files in `models/text_encoders` (not included in this repository):

- `Qwen-Image-2.1-Turbo-Uncensored-Q8_0.gguf`, from [AtomicChat](https://huggingface.co/AtomicChat/Qwen-Image-2.1-Turbo-Uncensored-GGUF).
- `qwen3vl_8b_int8_convrot.safetensors`, from [Comfy-Org](https://huggingface.co/Comfy-Org/Qwen-Image-2.1).

The denoiser and VAE are still the standard Qwen-Image 2.1 models named in `workflows/qwen-image-2.1-standard-v1.json`. Follow their respective licenses. Installing this encoder does not switch the denoiser to Turbo.

**Known limitations:** Reusing the reference image's generation seed reproduced excessive sharpening and ignored edits with both encoders. Changing only the edit seed restored the tested cup/tablecloth/book edit. Studio now rejects known reference-seed conflicts; imported images may have unknown seeds. See [the controlled comparison](../../docs/参考图编辑诊断.md). Windows model loading/unloading has also produced access violations; successful test runs do not establish long-term stability. This is an experimental integration.

To use the original native encoder instead, copy `workflows/qwen-image-2.1-original-encoder.json` over `workflows/qwen-image-2.1-standard-v1.json` and restart Studio. Existing tasks retain their frozen workflows.

To restore the previous GGUF CPU configuration, use `workflows/qwen-image-2.1-gguf-cpu.json` instead. Always wait for active image and chat generation before restarting.

`node integrations/comfyui-gguf/benchmark.mjs temp/benchmark.json --reference --configured` measures the configured workflow using only the existing synthetic `input/tavern-gguf-test-cup.png`. Without `--configured`, it measures the preserved CPU workflow. It refuses an occupied queue, records cached nodes, node wall times and one-second `nvidia-smi` samples, and writes images under `TavernBenchmark/`. These are observed memory peaks, not exact allocation peaks. Use `COMFY_BENCH_VARIANT=1` to change prompt whitespace and invalidate encoding cache for a repeated run; record this difference when comparing outputs. `--staged` is restricted to an isolated server on port 8189 via `COMFY_BENCH_URL`.
