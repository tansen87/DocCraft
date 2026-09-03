// Standalone MNN binding for PP-DocLayoutV3.
//
// Unlike ocr-rs's wrapper (which binds to the alphabetically-first session
// input — here `im_shape`), this selects the real **image** input by name and
// feeds the auxiliary `im_shape` / `scale_factor` inputs with neutral defaults,
// so the DETR layout model can actually run and produce its `[N, 7]` output.
//
// Lives at `<repo>/cpp/mnn/mnn_v3_wrapper.cpp`, built and linked by
// `src-tauri/build.rs`.
#include <MNN/Interpreter.hpp>
#include <MNN/Tensor.hpp>
#include <MNN/MNNDefine.h>

#include <cstring>
#include <cstdio>
#include <string>
#include <vector>
#include <memory>
#include <map>

namespace
{
template <typename T, typename... Args>
std::unique_ptr<T> make_unique_ptr(Args &&...args)
{
    return std::unique_ptr<T>(new T(std::forward<Args>(args)...));
}
} // namespace

extern "C"
{
    typedef struct MNNV3_Engine MNNV3_Engine;

    struct MNNV3_Engine
    {
        std::unique_ptr<MNN::Interpreter> interpreter;
        MNN::Session *session;
        int threads;
        int precision; // 0 normal, 1 low, 2 high
        std::string last_error;
        int last_status; // 0 ok
        std::vector<int> output_shape;
        std::vector<float> output_data;
        MNNV3_Engine() : session(nullptr), threads(4), precision(0), last_status(0) {}
    };

    MNNV3_Engine *mnnv3_create(const void *buffer, size_t size, int threads, int precision)
    {
        auto e = new MNNV3_Engine();
        if (!buffer || size == 0)
        {
            e->last_error = "empty buffer";
            e->last_status = 1;
            return e;
        }
        e->threads = (threads <= 0) ? 4 : threads;
        e->precision = precision;

        e->interpreter.reset(MNN::Interpreter::createFromBuffer(buffer, size));
        if (!e->interpreter)
        {
            e->last_error = "createFromBuffer failed";
            e->last_status = 1;
            return e;
        }

        MNN::ScheduleConfig schedule;
        MNN::BackendConfig backend;
        schedule.type = MNN_FORWARD_CPU;
        schedule.numThread = e->threads;
        switch (e->precision)
        {
        case 1:
            backend.precision = MNN::BackendConfig::Precision_Low;
            break;
        case 2:
            backend.precision = MNN::BackendConfig::Precision_High;
            break;
        default:
            backend.precision = MNN::BackendConfig::Precision_Normal;
            break;
        }
        schedule.backendConfig = &backend;

        e->session = e->interpreter->createSession(schedule);
        if (!e->session)
        {
            e->last_error = "createSession failed";
            e->last_status = 1;
            return e;
        }
        return e;
    }

    void mnnv3_destroy(MNNV3_Engine *e)
    {
        delete e;
    }

    const char *mnnv3_last_error(MNNV3_Engine *e)
    {
        return e ? e->last_error.c_str() : "null engine";
    }

    // Feed a single NCHW image [1,3,h,w] and run. Returns 0 on success and
    // copies the first output tensor into the engine's output buffers.
    int mnnv3_run(MNNV3_Engine *e, const float *image, size_t in_w, size_t in_h)
    {
        if (!e || !image)
        {
            return 1;
        }
        e->last_status = 0;
        e->last_error.clear();

        auto input_map = e->interpreter->getSessionInputAll(e->session);
        size_t image_elems = in_w * in_h * 3;

        MNN::Tensor *image_tensor = nullptr;
        MNN::Tensor *im_shape_tensor = nullptr;
        MNN::Tensor *scale_tensor = nullptr;

        for (auto &kv : input_map)
        {
            const std::string &name = kv.first;
            MNN::Tensor *t = kv.second;
            if (name.find("image") != std::string::npos ||
                name.find("im_shape") == std::string::npos && name.find("scale_factor") == std::string::npos)
            {
                // Prefer a tensor literally named "image".
            }
            if (name == "image")
            {
                image_tensor = t;
            }
            else if (name == "im_shape")
            {
                im_shape_tensor = t;
            }
            else if (name == "scale_factor")
            {
                scale_tensor = t;
            }
        }

        // Fallback: any input whose shape is 4D NCHW is the image input.
        if (!image_tensor)
        {
            for (auto &kv : input_map)
            {
                MNN::Tensor *t = kv.second;
                if (t->dimensions() == 4)
                {
                    image_tensor = t;
                    break;
                }
            }
        }
        if (!image_tensor)
        {
            e->last_error = "no 4D image input found; inputs: " + std::to_string(input_map.size());
            e->last_status = 1;
            return 1;
        }

        // Resize the image input to the actual input size.
        std::vector<int> shape = {(int)1, 3, (int)in_h, (int)in_w};
        e->interpreter->resizeTensor(image_tensor, shape);

        // Set the aux input shapes to [1, 2] (im_shape) / [1, 2] (scale_factor)
        // before recomputing the graph, so the internal Div/scale ops broadcast.
        if (im_shape_tensor)
        {
            e->interpreter->resizeTensor(im_shape_tensor, {(int)1, 2});
        }
        if (scale_tensor)
        {
            e->interpreter->resizeTensor(scale_tensor, {(int)1, 2});
        }
        e->interpreter->resizeSession(e->session);

        // resizeSession may reallocate the input tensors; re-fetch them before
        // writing host data (mirrors ocr_rs's dynamic wrapper). Using a stale
        // pointer here caused MNN shape/compute errors (e.g. Div broadcast).
        image_tensor = nullptr;
        im_shape_tensor = nullptr;
        scale_tensor = nullptr;
        auto input_map2 = e->interpreter->getSessionInputAll(e->session);
        for (auto &kv : input_map2)
        {
            if (kv.first == "image")
            {
                image_tensor = kv.second;
            }
            else if (kv.first == "im_shape")
            {
                im_shape_tensor = kv.second;
            }
            else if (kv.first == "scale_factor")
            {
                scale_tensor = kv.second;
            }
        }
        if (!image_tensor)
        {
            for (auto &kv : input_map2)
            {
                if (kv.second->dimensions() == 4)
                {
                    image_tensor = kv.second;
                    break;
                }
            }
        }
        if (!image_tensor)
        {
            e->last_error = "image input lost after resizeSession";
            e->last_status = 1;
            return 1;
        }

        // image: copy host data into the (fresh) device tensor.
        auto image_host = make_unique_ptr<MNN::Tensor>(image_tensor, MNN::Tensor::CAFFE);
        if (!image_host->host<float>())
        {
            e->last_error = "image host tensor has null buffer";
            e->last_status = 1;
            return 1;
        }
        std::memcpy(image_host->host<float>(), image, image_elems * sizeof(float));
        image_tensor->copyFromHostTensor(image_host.get());

        // aux inputs: neutral defaults. im_shape = input dims, scale_factor = ones.
        if (im_shape_tensor)
        {
            auto host = make_unique_ptr<MNN::Tensor>(im_shape_tensor, MNN::Tensor::CAFFE);
            if (host->host<float>())
            {
                float *p = host->host<float>();
                size_t n = host->elementSize();
                for (size_t i = 0; i < n; ++i)
                {
                    p[i] = (i % 2 == 0) ? (float)in_h : (float)in_w;
                }
                im_shape_tensor->copyFromHostTensor(host.get());
            }
        }
        if (scale_tensor)
        {
            auto host = make_unique_ptr<MNN::Tensor>(scale_tensor, MNN::Tensor::CAFFE);
            if (host->host<float>())
            {
                float *p = host->host<float>();
                size_t n = host->elementSize();
                for (size_t i = 0; i < n; ++i)
                {
                    p[i] = 1.0f;
                }
                scale_tensor->copyFromHostTensor(host.get());
            }
        }

        MNN::ErrorCode code = e->interpreter->runSession(e->session);
        if (code != MNN::NO_ERROR)
        {
            e->last_error = "runSession failed code=" + std::to_string(code);
            e->last_status = 1;
            return 1;
        }

        auto output_map = e->interpreter->getSessionOutputAll(e->session);
        if (output_map.empty())
        {
            e->last_error = "no output tensors";
            e->last_status = 1;
            return 1;
        }

        // Take the alphabetically-first output (single `[N, 7]` tensor for V3).
        MNN::Tensor *out = output_map.begin()->second;
        auto out_shape = out->shape();
        e->output_shape.assign(out_shape.begin(), out_shape.end());
        size_t total = 1;
        for (int d : out_shape)
        {
            total *= (size_t)d;
        }
        auto out_host = make_unique_ptr<MNN::Tensor>(out, MNN::Tensor::CAFFE);
        if (!out_host->host<float>())
        {
            e->last_error = "output host tensor has null buffer";
            e->last_status = 1;
            return 1;
        }
        out->copyToHostTensor(out_host.get());
        e->output_data.assign(out_host->host<float>(), out_host->host<float>() + total);
        return 0;
    }

    const float *mnnv3_output_data(MNNV3_Engine *e, size_t *len)
    {
        if (e)
        {
            *len = e->output_data.size();
            return e->output_data.data();
        }
        *len = 0;
        return nullptr;
    }

    void mnnv3_output_shape(MNNV3_Engine *e, size_t *dims, size_t *ndims)
    {
        if (!e)
        {
            return;
        }
        *ndims = e->output_shape.size();
        for (size_t i = 0; i < e->output_shape.size() && i < 8; ++i)
        {
            dims[i] = (size_t)e->output_shape[i];
        }
    }

    // Diagnostic: run and dump every session output's name / shape / first rows
    // to stdout, so the correct output tensor can be selected in the Rust side.
    void mnnv3_dump_outputs(MNNV3_Engine *e, const float *image, size_t in_w, size_t in_h)
    {
        if (!e || !image)
        {
            return;
        }
        // Reuse the run path but with raw MNN calls so we can enumerate outputs.
        auto input_map = e->interpreter->getSessionInputAll(e->session);
        MNN::Tensor *image_t = nullptr;
        MNN::Tensor *im_shape_t = nullptr;
        MNN::Tensor *scale_t = nullptr;
        for (auto &kv : input_map)
        {
            if (kv.first == "image")
                image_t = kv.second;
            else if (kv.first == "im_shape")
                im_shape_t = kv.second;
            else if (kv.first == "scale_factor")
                scale_t = kv.second;
        }
        if (!image_t)
        {
            std::fprintf(stderr, "[mnnv3_dump_outputs] no image input\n");
            return;
        }
        size_t elems = in_w * in_h * 3;
        std::vector<int> shp = {(int)1, 3, (int)in_h, (int)in_w};
        e->interpreter->resizeTensor(image_t, shp);
        e->interpreter->resizeSession(e->session);
        auto ih = make_unique_ptr<MNN::Tensor>(image_t, MNN::Tensor::CAFFE);
        std::memcpy(ih->host<float>(), image, elems * sizeof(float));
        image_t->copyFromHostTensor(ih.get());
        if (im_shape_t)
        {
            auto h = make_unique_ptr<MNN::Tensor>(im_shape_t, MNN::Tensor::CAFFE);
            float *p = h->host<float>();
            p[0] = (float)in_h;
            p[1] = (float)in_w;
            im_shape_t->copyFromHostTensor(h.get());
        }
        if (scale_t)
        {
            auto h = make_unique_ptr<MNN::Tensor>(scale_t, MNN::Tensor::CAFFE);
            size_t n = h->elementSize();
            for (size_t i = 0; i < n; ++i)
                h->host<float>()[i] = 1.0f;
            scale_t->copyFromHostTensor(h.get());
        }
        e->interpreter->runSession(e->session);

        auto omap = e->interpreter->getSessionOutputAll(e->session);
        std::fprintf(stdout, "[mnnv3_dump_outputs] output count = %zu\n", omap.size());
        for (auto &kv : omap)
        {
            MNN::Tensor *t = kv.second;
            auto sh = t->shape();
            std::fprintf(stdout, "[out] name=%s shape=[", kv.first.c_str());
            for (size_t i = 0; i < sh.size(); ++i)
                std::fprintf(stdout, "%d%s", sh[i], i + 1 == sh.size() ? "" : ",");
            std::fprintf(stdout, "]\n");
            auto oh = make_unique_ptr<MNN::Tensor>(t, MNN::Tensor::CAFFE);
            t->copyToHostTensor(oh.get());
            float *d = oh->host<float>();
            size_t n = oh->elementSize();
            size_t show = n < 24 ? n : 24;
            std::fprintf(stdout, "[out] first %zu vals: ", show);
            for (size_t i = 0; i < show; ++i)
                std::fprintf(stdout, "%.3f ", d[i]);
            std::fprintf(stdout, "\n");
        }
        std::fflush(stdout);
    }
} // extern "C"