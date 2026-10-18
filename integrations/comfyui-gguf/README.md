# Qwen-Image 2.1 GGUF integration (experimental)

Install [ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) at commit `6ea2651e7df66d7585f6ffee804b20e92fb38b8a` in your ComfyUI `custom_nodes` directory and install its requirements in the ComfyUI Python environment. The tested GGUF package version is 0.19.0.

Copy `tavern_qwen.py` from this directory into `custom_nodes/ComfyUI-GGUF/`. In that extension's `__init__.py`, immediately after `from .nodes import NODE_CLASS_MAPPINGS`, add:

```python
    from .tavern_qwen import TavernQwen21CLIPLoaderGGUF
    NODE_CLASS_MAPPINGS["TavernQwen21CLIPLoaderGGUF"] = TavernQwen21CLIPLoaderGGUF
```

Restart ComfyUI. This registers `TavernQwen21CLIPLoaderGGUF` used by Studio's current workflow. The adapter runs text encoding on CPU, keeps the original Qwen3-VL vision tower, and leaves image sampling on GPU.

Required files in `models/text_encoders` (not included in this repository):

- `Qwen-Image-2.1-Turbo-Uncensored-Q8_0.gguf`, from [AtomicChat](https://huggingface.co/AtomicChat/Qwen-Image-2.1-Turbo-Uncensored-GGUF).
- `qwen3vl_8b_int8_convrot.safetensors`, from [Comfy-Org](https://huggingface.co/Comfy-Org/Qwen-Image-2.1).

The denoiser and VAE are still the standard Qwen-Image 2.1 models named in `workflows/qwen-image-2.1-standard-v1.json`. Follow their respective licenses. Installing this encoder does not switch the denoiser to Turbo.

**Known limitations:** Reference editing has produced excessive sharpening and failed to follow some edit instructions. Diagnosis is ongoing. Windows model loading/unloading has also produced access violations; successful test runs do not establish long-term stability. This is an experimental integration.

To use the original native encoder instead, copy `workflows/qwen-image-2.1-original-encoder.json` over `workflows/qwen-image-2.1-standard-v1.json` and restart Studio. Existing tasks retain their frozen workflows.
