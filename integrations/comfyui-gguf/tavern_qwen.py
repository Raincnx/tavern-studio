"""Qwen-Image 2.1 GGUF language weights with the unchanged native vision tower."""
import torch
import comfy.sd
import comfy.model_management
import folder_paths
from comfy_extras.nodes_qwen import TextEncodeQwenImage21
from safetensors import safe_open
from .nodes import CLIPLoaderGGUF, GGUFModelPatcher
from .ops import GGMLOps
from .dequant import is_quantized

class TavernQwen21CLIPLoaderGGUF(CLIPLoaderGGUF):
    TITLE = "Qwen-Image 2.1 GGUF + native vision"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "clip_name": (cls.get_filename_list(),),
            "vision_name": (folder_paths.get_filename_list("clip"),),
        }, "optional": {"execution_device": (["cpu", "cuda"], {"default": "cpu"})}}

    def load_patcher(self, clip_paths, clip_type, clip_data, execution_device="cpu"):
        if execution_device not in ("cpu", "cuda"):
            raise ValueError("execution_device must be cpu or cuda")
        gpu = execution_device == "cuda"
        if gpu:
            # ComfyUI detects Qwen compute dtype from the checkpoint's norm weights.
            # model_options.dtype alone does not override the GGUF's F32 norms.
            for state in clip_data:
                for key, value in state.items():
                    if torch.is_tensor(value) and not is_quantized(value) and value.is_floating_point():
                        state[key] = value.to(dtype=torch.bfloat16)
        clip = comfy.sd.load_text_encoder_state_dicts(
            clip_type=clip_type, state_dicts=clip_data,
            model_options={"custom_operations": GGMLOps, "load_device": torch.device("cuda:0" if gpu else "cpu"), "offload_device": torch.device("cpu"), "initial_device": torch.device("cpu"), "dtype": torch.bfloat16 if gpu else torch.float32},
            embedding_directory=folder_paths.get_folder_paths("embeddings"),
        )
        clip.patcher = GGUFModelPatcher.clone(clip.patcher)
        return clip

    def load_clip(self, clip_name, vision_name, execution_device="cpu"):
        clip_path = folder_paths.get_full_path_or_raise("clip", clip_name)
        vision_path = folder_paths.get_full_path_or_raise("clip", vision_name)
        data = self.load_data([clip_path])
        # Qwen3-VL's unmodified vision tower is absent from its language GGUF.
        with safe_open(vision_path, framework="pt", device="cpu") as source:
            for key in source.keys():
                if key.startswith("model.visual."):
                    data[0][key] = source.get_tensor(key).clone()
        if "model.visual.deepstack_merger_list.0.norm.weight" not in data[0]:
            raise ValueError("A complete Qwen3-VL vision tower is required")
        return (self.load_patcher([clip_path, vision_path], comfy.sd.CLIPType.QWEN_IMAGE, data, execution_device),)


class TavernQwen21TextEncodeStaged(TextEncodeQwenImage21):
    TITLE = "Qwen Image 2.1 Encode (staged memory)"

    @classmethod
    def define_schema(cls):
        schema = super().define_schema()
        schema.node_id = "TavernQwen21TextEncodeStaged"
        schema.display_name = cls.TITLE
        return schema

    @classmethod
    def execute(cls, clip, prompt, negative_prompt, vae=None, resolution=1024, images=None):
        # Keep the denoiser out of the encoding phase and avoid partial TE unload
        # when sampling starts (the previous Windows crash occurred on that path).
        comfy.model_management.unload_all_models()
        try:
            return super().execute(clip, prompt, negative_prompt, vae, resolution, images)
        finally:
            comfy.model_management.unload_all_models()
