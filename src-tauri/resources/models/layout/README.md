# Layout Analysis Models (docs/design/00016)

This directory is the **layout model pool** used by the local OCR "版面分析"
feature. Every subdirectory is one model:

```
resources/models/layout/
├─ PP-DocLayout-S/            PP-DocLayout-S.mnn + layout-meta.json + config.json (23 classes, default)
├─ PicoDet-S_layout_17cls/    PicoDet-S-layout-17cls.mnn + meta + config.json     (17 classes)
├─ PicoDet_layout_1x/         PicoDet_layout_1x.mnn + meta + config.json          (PubLayNet 5 classes)
└─ PicoDet_layout_1x_table/   PicoDet_layout_1x_table.mnn + meta + config.json    (1 class, tables only)
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
  "name": "PP-DocLayout-S",              // stable name (= directory name)
  "displayName": "PP-DocLayout-S", // shown in the settings select
  "modelFile": "PP-DocLayout-S.mnn",     // model file inside this directory
  "inputWidth": 480,                     // input size (from config.json)
  "inputHeight": 480,
  "keepRatio": false,                    // false = stretch (PicoDet), true = letterbox
  "mean": [0.485, 0.456, 0.406],         // RGB mean for normalization
  "std":  [0.229, 0.224, 0.225],         // RGB std  for normalization
  "scoreThreshold": 0.5,                 // PicoDet recommended threshold
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
