# Layout Analysis Models (docs/design/00016)

This directory is the **layout model pool** used by the local OCR "版面分析"
feature. Every subdirectory is one model:

```
resources/models/layout/
└─ PP-DocLayoutV3/            PP-DocLayoutV3.mnn + layout-meta.json (DETR, 25 classes)
```

`config.json` is the **model's own exported config** (downloaded together with the
weights, e.g. from ModelScope). It is the source of truth for calibration:
`Preprocess[].Resize.target_size` + `keep_ratio` give the input size / resize
mode, and `label_list` gives the **class-id order** that `layout-meta.json`
must mirror. When you convert a new model, copy its config.json into the
directory and align `layout-meta.json` with it.

The engine discovers models by scanning this directory (`list_layout_models`):
a directory is listed as soon as its `layout-meta.json` parses, and becomes
**available** once the model file it declares exists. Adding a new model =
dropping a new directory here — **no code change needed**.

## layout-meta.json format

```jsonc
{
  "name": "PP-DocLayoutV3",              // stable name (= directory name)
  "displayName": "PP-DocLayoutV3", // shown in the settings select
  "modelFile": "PP-DocLayoutV3.mnn",     // model file inside this directory
  "inputWidth": 480,                     // input size (from config.json)
  "inputHeight": 480,
  "keepRatio": false,                    // false = stretch (PicoDet), true = letterbox
  "mean": [0.485, 0.456, 0.406],         // RGB mean for normalization
  "std":  [0.229, 0.224, 0.225],         // RGB std  for normalization
  "scoreThreshold": 0.5,                 // PicoDet recommended threshold
  "engine": "picodet",                   // "picodet" (rows-of-6) | "detr" (PP-DocLayoutV3 [N,7])
  "classes": [ /* class table in class-id order */ ],
  "bucketMap": {                         // class name -> processing bucket
    "doc_title": "Title"                 // Title|Text|Table|Figure|Header|Footer|Seal
  }
}
```

- `modelFile` defaults to `model.mnn`; bundled models may ship under their own
  name and declare it here.
- `inputWidth` / `inputHeight` and `keepRatio` come from the model's
  `config.json` (`Preprocess[].Resize`). When the input size is unset (0), the
  engine reads it from the model's own input tensor at load time.
- `classes` order **must match the converted model's class-id order** — a
  wrong order misclassifies regions (still output as text, never a crash). If
  a model classifies things wrongly (e.g. headings not becoming titles), the
  first thing to check is this array.

The `bucketMap` maps each class name to one of the internal processing
buckets. Classes with no entry fall back to a name-based guess; anything that
still matches no bucket is treated as body text (`Other`), so models with
different class counts (1 / 5 / 17 / 23) work unchanged. The engine decodes
the model output as `[class_id, score, x1, y1, x2, y2]` rows in the letterboxed
input space and maps coordinates back to the original image.

### DETR models (PP-DocLayoutV3)

`engine: "detr"` selects the **standalone MNN binding** (`cpp/mnn`, the repo-root
sibling of `src-tauri`, built by `src-tauri/build.rs`) instead of `ocr_rs`.
PP-DocLayoutV3's graph has three
inputs (`image`, `im_shape`, `scale_factor`) and `ocr_rs`'s single-input wrapper
grabs `im_shape` by accident, so it cannot drive the model; the vendored wrapper
selects `image` by name and feeds neutral aux inputs.

The DETR head emits three outputs; only `fetch_name_0` (`[N, 7]` =
`[class_id, score, x1, y1, x2, y2, reading_order]`) is consumed. Coordinates map
back with the model's `inputWidth/inputHeight` + `keep_ratio`, and regions are
emitted in the model's predicted reading order. Normalization uses `mean/std`
exactly (`[0,0,0]/[1,1,1]` → `pixel/255`), so a DETR model must always set
`inputWidth` / `inputHeight` in its `layout-meta.json`.
