"use strict";

importScripts("./model.js");

const cancelledTasks = new Set();
const MAX_DURATION_MS = 30_000;
const PIXELS_PER_CHUNK = 100_000;
const ANALYSIS_SIZE = 64;

self.addEventListener("message", (event) => {
    const message = event.data;

    if (message.type === "cancel") {
        cancelledTasks.add(message.taskId);
        return;
    }

    if (message.type === "process") {
        processTask(message).catch((error) => {
            if (error instanceof CancelledError) {
                return;
            }

            self.postMessage({
                type: "error",
                taskId: message.taskId,
                message: error instanceof Error
                    ? error.message
                    : "Ошибка обработки изображения."
            });
        });
    }
});

async function processTask(message) {
    const startTime = performance.now();
    const {
        taskId,
        imageBlob,
        outputType,
        parameters: requestedParameters
    } = message;

    checkTask(taskId, startTime);
    sendStatus(taskId, "decoding", 5);

    const bitmap = await createImageBitmap(imageBlob);
    const width = bitmap.width;
    const height = bitmap.height;
    const megapixels = width * height / 1_000_000;

    if (megapixels > 15) {
        bitmap.close?.();
        throw new Error(
            `Размер изображения — ${megapixels.toFixed(2)} Мп. ` +
            "Допустимо не более 15 Мп."
        );
    }

    checkTask(taskId, startTime);

    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { willReadFrequently: true });

    if (!context) {
        bitmap.close?.();
        throw new Error("Не удалось подготовить изображение к обработке.");
    }

    context.drawImage(bitmap, 0, 0);

    let parameters;

    if (requestedParameters) {
        parameters = { ...requestedParameters };
        validateParameters(parameters);
    } else {
        sendStatus(taskId, "analyzing", 15);

        const analysisCanvas = new OffscreenCanvas(ANALYSIS_SIZE, ANALYSIS_SIZE);
        const analysisContext = analysisCanvas.getContext("2d", {
            willReadFrequently: true
        });

        if (!analysisContext) {
            bitmap.close?.();
            throw new Error("Не удалось выполнить анализ изображения.");
        }

        analysisContext.imageSmoothingEnabled = true;
        analysisContext.imageSmoothingQuality = "high";
        analysisContext.drawImage(bitmap, 0, 0, ANALYSIS_SIZE, ANALYSIS_SIZE);

        const analysisPixels = analysisContext.getImageData(
            0,
            0,
            ANALYSIS_SIZE,
            ANALYSIS_SIZE
        ).data;

        const features = extractFeatures(analysisPixels);

        if (
            !self.EnhancementModel ||
            typeof self.EnhancementModel.predict !== "function"
        ) {
            bitmap.close?.();
            throw new Error("Не удалось загрузить модель.");
        }

        parameters = self.EnhancementModel.predict(features);
        validateParameters(parameters);
    }

    bitmap.close?.();

    self.postMessage({
        type: "parameters",
        taskId,
        parameters
    });

    const imageData = context.getImageData(0, 0, width, height);
    const pixels = imageData.data;

    sendStatus(taskId, "processing", 25);

    await applyCorrectionInChunks({
        taskId,
        pixels,
        parameters,
        startTime
    });

    checkTask(taskId, startTime);
    context.putImageData(imageData, 0, 0);

    sendStatus(taskId, "encoding", 94);

    const resultBlob = await canvas.convertToBlob({
        type: outputType,
        quality: 0.92
    });

    checkTask(taskId, startTime);
    cancelledTasks.delete(taskId);

    self.postMessage({
        type: "completed",
        taskId,
        resultBlob,
        width,
        height,
        durationMs: Math.round(performance.now() - startTime),
        parameters
    });
}

function extractFeatures(pixels) {
    const pixelCount = pixels.length / 4;
    const histogram = new Uint32Array(256);

    let brightnessSum = 0;
    let brightnessSquareSum = 0;
    let saturationSum = 0;
    let darkPixels = 0;
    let brightPixels = 0;

    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
        const index = pixelIndex * 4;
        const red = pixels[index] / 255;
        const green = pixels[index + 1] / 255;
        const blue = pixels[index + 2] / 255;

        const brightness = 0.299 * red + 0.587 * green + 0.114 * blue;
        const maximum = Math.max(red, green, blue);
        const minimum = Math.min(red, green, blue);
        const saturation = maximum > 0
            ? (maximum - minimum) / maximum
            : 0;

        brightnessSum += brightness;
        brightnessSquareSum += brightness * brightness;
        saturationSum += saturation;

        const histogramIndex = Math.min(
            255,
            Math.max(0, Math.round(brightness * 255))
        );
        histogram[histogramIndex] += 1;

        if (brightness < 0.20) {
            darkPixels += 1;
        }

        if (brightness > 0.80) {
            brightPixels += 1;
        }
    }

    if (pixelCount === 0) {
        throw new Error("Не удалось получить параметры изображения.");
    }

    const meanBrightness = brightnessSum / pixelCount;
    const variance = Math.max(
        0,
        brightnessSquareSum / pixelCount - meanBrightness * meanBrightness
    );

    return [
        meanBrightness,
        Math.sqrt(variance),
        saturationSum / pixelCount,
        darkPixels / pixelCount,
        brightPixels / pixelCount,
        (
            percentile(histogram, pixelCount, 0.90) -
            percentile(histogram, pixelCount, 0.10)
        ) / 255
    ];
}

function percentile(histogram, total, part) {
    const target = total * part;
    let count = 0;

    for (let value = 0; value < histogram.length; value += 1) {
        count += histogram[value];

        if (count >= target) {
            return value;
        }
    }

    return 255;
}

function validateParameters(parameters) {
    if (
        !parameters ||
        !Number.isFinite(parameters.brightness) ||
        !Number.isFinite(parameters.contrast) ||
        !Number.isFinite(parameters.saturation)
    ) {
        throw new Error("Получены некорректные настройки изображения.");
    }

    if (
        parameters.brightness <= 0 ||
        parameters.contrast <= 0 ||
        parameters.saturation < 0
    ) {
        throw new Error("Значения настроек выходят за допустимый диапазон.");
    }
}

async function applyCorrectionInChunks({
    taskId,
    pixels,
    parameters,
    startTime
}) {
    const totalPixels = pixels.length / 4;

    for (
        let pixelStart = 0;
        pixelStart < totalPixels;
        pixelStart += PIXELS_PER_CHUNK
    ) {
        checkTask(taskId, startTime);

        const pixelEnd = Math.min(
            pixelStart + PIXELS_PER_CHUNK,
            totalPixels
        );

        for (
            let pixelIndex = pixelStart;
            pixelIndex < pixelEnd;
            pixelIndex += 1
        ) {
            const index = pixelIndex * 4;

            let red = pixels[index] * parameters.brightness;
            let green = pixels[index + 1] * parameters.brightness;
            let blue = pixels[index + 2] * parameters.brightness;

            red = (red - 127.5) * parameters.contrast + 127.5;
            green = (green - 127.5) * parameters.contrast + 127.5;
            blue = (blue - 127.5) * parameters.contrast + 127.5;

            const gray = 0.299 * red + 0.587 * green + 0.114 * blue;

            red = gray + parameters.saturation * (red - gray);
            green = gray + parameters.saturation * (green - gray);
            blue = gray + parameters.saturation * (blue - gray);

            pixels[index] = clampColor(red);
            pixels[index + 1] = clampColor(green);
            pixels[index + 2] = clampColor(blue);
        }

        const processed = pixelEnd / totalPixels;

        sendStatus(
            taskId,
            "processing",
            25 + Math.round(processed * 65)
        );

        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

function checkTask(taskId, startTime) {
    if (cancelledTasks.has(taskId)) {
        cancelledTasks.delete(taskId);
        self.postMessage({ type: "cancelled", taskId });
        throw new CancelledError();
    }

    if (performance.now() - startTime > MAX_DURATION_MS) {
        throw new Error("Обработка заняла больше 30 секунд.");
    }
}

function sendStatus(taskId, status, progress) {
    self.postMessage({
        type: "status",
        taskId,
        status,
        progress
    });
}

function clampColor(value) {
    return Math.max(0, Math.min(255, Math.round(value)));
}

class CancelledError extends Error {}
