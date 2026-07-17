"use strict";

const MAX_MEGAPIXELS = 15;
const ALLOWED_EXTENSIONS = new Set(["jpg", "jpeg", "png", "bmp", "heic"]);

class ImageEnhancerAPI extends EventTarget {
    constructor(workerUrl) {
        super();
        this.tasks = new Map();
        this.worker = new Worker(workerUrl);
        this.worker.addEventListener("message", (event) => this.handleMessage(event.data));
        this.worker.addEventListener("error", (event) => {
            event.preventDefault();
            this.failActiveTasks(event.message || "Не удалось запустить обработчик изображения.");
        });
        this.worker.addEventListener("messageerror", () => {
            this.failActiveTasks("Не удалось прочитать ответ обработчика изображения.");
        });
    }

    createTask(imageBlob, outputType = "image/jpeg", parameters = null, mode = "model") {
        const taskId = crypto.randomUUID
            ? crypto.randomUUID()
            : `task-${Date.now()}-${Math.random().toString(16).slice(2)}`;

        let resolveResult;
        let rejectResult;

        const resultPromise = new Promise((resolve, reject) => {
            resolveResult = resolve;
            rejectResult = reject;
        });

        const task = {
            taskId,
            mode,
            status: "queued",
            progress: 0,
            parameters: null,
            result: null,
            error: null,
            resultPromise,
            resolveResult,
            rejectResult
        };

        this.tasks.set(taskId, task);
        this.emitStatus(task);

        this.worker.postMessage({
            type: "process",
            taskId,
            imageBlob,
            outputType,
            parameters
        });

        return taskId;
    }

    getTaskStatus(taskId) {
        const task = this.requireTask(taskId);

        return {
            taskId: task.taskId,
            mode: task.mode,
            status: task.status,
            progress: task.progress,
            parameters: task.parameters,
            error: task.error
        };
    }

    cancelTask(taskId) {
        const task = this.requireTask(taskId);

        if (["completed", "cancelled", "error"].includes(task.status)) {
            return false;
        }

        this.worker.postMessage({ type: "cancel", taskId });
        return true;
    }

    getResult(taskId) {
        return this.requireTask(taskId).resultPromise;
    }

    handleMessage(message) {
        const task = this.tasks.get(message.taskId);

        if (!task) {
            return;
        }

        if (message.type === "status") {
            task.status = message.status;
            task.progress = message.progress;
            this.emitStatus(task);
            return;
        }

        if (message.type === "parameters") {
            task.parameters = message.parameters;
            this.emitStatus(task);
            return;
        }

        if (message.type === "completed") {
            task.status = "completed";
            task.progress = 100;
            task.parameters = message.parameters;
            task.result = message.resultBlob;
            this.emitStatus(task);
            task.resolveResult(message.resultBlob);
            return;
        }

        if (message.type === "cancelled") {
            task.status = "cancelled";
            this.emitStatus(task);
            task.rejectResult(new Error("Обработка отменена."));
            return;
        }

        if (message.type === "error") {
            if (task.status === "cancelled") {
                return;
            }

            task.status = "error";
            task.error = message.message;
            this.emitStatus(task);
            task.rejectResult(new Error(message.message));
        }
    }

    emitStatus(task) {
        this.dispatchEvent(new CustomEvent("statuschange", {
            detail: this.getTaskStatus(task.taskId)
        }));
    }

    failActiveTasks(message) {
        for (const task of this.tasks.values()) {
            if (["completed", "cancelled", "error"].includes(task.status)) {
                continue;
            }

            task.status = "error";
            task.error = message;
            this.emitStatus(task);
            task.rejectResult(new Error(message));
        }
    }

    requireTask(taskId) {
        const task = this.tasks.get(taskId);

        if (!task) {
            throw new Error("Задача не найдена.");
        }

        return task;
    }
}

const elements = Object.fromEntries([
    "imageInput",
    "selectedFileName",
    "message",
    "imageSection",
    "fileName",
    "imageSize",
    "originalPreview",
    "resultFigure",
    "resultPreview",
    "processButton",
    "progressSection",
    "statusText",
    "progressValue",
    "progressBar",
    "cancelButton",
    "parametersSection",
    "brightnessValue",
    "contrastValue",
    "saturationValue",
    "brightnessRange",
    "brightnessRangeValue",
    "contrastRange",
    "contrastRangeValue",
    "saturationRange",
    "saturationRangeValue",
    "applySettingsButton",
    "resetSettingsButton",
    "downloadButton"
].map((id) => [id, document.getElementById(id)]));

const enhancer = new ImageEnhancerAPI("./image-worker.js");

let sourceFile = null;
let processingBlob = null;
let sourceUrl = null;
let resultBlob = null;
let resultUrl = null;
let currentTaskId = null;
let outputType = "image/jpeg";
let modelParameters = null;

initializeControls();

function initializeControls() {
    elements.imageInput.addEventListener("change", handleFileSelection);
    elements.processButton.addEventListener("click", startModelProcessing);
    elements.cancelButton.addEventListener("click", cancelProcessing);
    elements.applySettingsButton.addEventListener("click", applyManualSettings);
    elements.resetSettingsButton.addEventListener("click", resetToModelSettings);
    elements.downloadButton.addEventListener("click", downloadResult);
    enhancer.addEventListener("statuschange", handleStatusChange);

    for (const range of [
        elements.brightnessRange,
        elements.contrastRange,
        elements.saturationRange
    ]) {
        range.addEventListener("input", updateRangeLabels);
    }

    setSettingsEnabled(false);
    updateRangeLabels();
}

async function handleFileSelection() {
    resetResult();
    clearSource();

    const file = elements.imageInput.files?.[0];

    if (!file) {
        return;
    }

    elements.selectedFileName.textContent = file.name;

    try {
        const extension = getExtension(file.name);

        if (!ALLOWED_EXTENSIONS.has(extension)) {
            throw new Error("Этот формат не поддерживается.");
        }

        showMessage("Открываем файл…", "warning");

        const prepared = await prepareFile(file, extension);
        const bitmap = await createImageBitmap(prepared.blob);
        const megapixels = bitmap.width * bitmap.height / 1_000_000;

        if (megapixels > MAX_MEGAPIXELS) {
            bitmap.close?.();
            throw new Error(
                `Размер изображения — ${megapixels.toFixed(2)} Мп. Допустимо не более 15 Мп.`
            );
        }

        sourceFile = file;
        processingBlob = prepared.blob;
        outputType = prepared.outputType;

        releaseSourceUrl();
        sourceUrl = URL.createObjectURL(prepared.blob);
        elements.originalPreview.src = sourceUrl;
        elements.fileName.textContent = file.name;
        elements.imageSize.textContent = `${bitmap.width} × ${bitmap.height} · ${megapixels.toFixed(2)} Мп`;
        bitmap.close?.();

        elements.imageSection.classList.remove("hidden");
        elements.processButton.disabled = false;
        showMessage("Файл загружен.", "success");
    } catch (error) {
        elements.imageInput.value = "";
        elements.selectedFileName.textContent = "Файл не выбран";
        showMessage(error.message || "Не удалось открыть изображение.", "error");
    }
}

async function prepareFile(file, extension) {
    if (extension !== "heic") {
        return {
            blob: file,
            outputType: extension === "png" ? "image/png" : "image/jpeg"
        };
    }

    if (typeof window.heic2any !== "function") {
        throw new Error("Не удалось открыть HEIC. Проверьте подключение к интернету.");
    }

    showMessage("Преобразуем HEIC…", "warning");

    const converted = await window.heic2any({
        blob: file,
        toType: "image/jpeg",
        quality: 0.92
    });

    return {
        blob: Array.isArray(converted) ? converted[0] : converted,
        outputType: "image/jpeg"
    };
}

function startModelProcessing() {
    if (!processingBlob || currentTaskId) {
        return;
    }

    resetResult();
    runProcessing(null, "model");
}

function applyManualSettings() {
    if (!processingBlob || !modelParameters || currentTaskId) {
        return;
    }

    runProcessing(readManualParameters(), "manual");
}

function resetToModelSettings() {
    if (!modelParameters || currentTaskId) {
        return;
    }

    setRanges(modelParameters);
    runProcessing({ ...modelParameters }, "manual");
}

function runProcessing(parameters, mode) {
    const taskId = enhancer.createTask(
        processingBlob,
        outputType,
        parameters,
        mode
    );

    currentTaskId = taskId;
    elements.progressSection.classList.remove("hidden");
    elements.cancelButton.classList.remove("hidden");
    setBusy(true);

    if (mode === "manual") {
        showMessage("Применяем настройки…", "warning");
    } else {
        showMessage("Подбираем настройки…", "warning");
    }

    enhancer.getResult(taskId)
        .then((blob) => showResult(blob, mode))
        .catch((error) => {
            const status = enhancer.getTaskStatus(taskId).status;

            if (status !== "cancelled") {
                showMessage(error.message, "error");
            }
        })
        .finally(() => {
            if (currentTaskId === taskId) {
                currentTaskId = null;
            }

            setBusy(false);
        });
}

function handleStatusChange(event) {
    const detail = event.detail;

    if (detail.taskId !== currentTaskId) {
        return;
    }

    elements.progressBar.value = detail.progress;
    elements.progressValue.textContent = `${detail.progress}%`;
    elements.statusText.textContent = statusText(detail.status, detail.mode);

    if (detail.parameters && detail.mode === "model") {
        modelParameters = { ...detail.parameters };
        showModelParameters(modelParameters);
        setRanges(modelParameters);
        setSettingsEnabled(true);
        elements.parametersSection.classList.remove("hidden");
    }

    if (detail.status === "completed") {
        elements.cancelButton.classList.add("hidden");
    }

    if (detail.status === "cancelled") {
        elements.cancelButton.classList.add("hidden");
        showMessage("Обработка отменена.", "warning");
    }

    if (detail.status === "error") {
        elements.cancelButton.classList.add("hidden");
        showMessage(detail.error || "Во время обработки произошла ошибка.", "error");
    }
}

function cancelProcessing() {
    if (currentTaskId) {
        enhancer.cancelTask(currentTaskId);
    }
}

function showResult(blob, mode) {
    resultBlob = blob;
    releaseResultUrl();
    resultUrl = URL.createObjectURL(blob);
    elements.resultPreview.src = resultUrl;
    elements.resultFigure.classList.remove("hidden");
    elements.progressBar.value = 100;
    elements.progressValue.textContent = "100%";
    elements.statusText.textContent = "Готово";
    elements.cancelButton.classList.add("hidden");
    elements.downloadButton.disabled = false;

    if (mode === "model") {
        showMessage("Готово. При необходимости измените настройки ниже.", "success");
    } else {
        showMessage("Настройки применены.", "success");
    }
}

function showModelParameters(parameters) {
    elements.brightnessValue.textContent = toPercent(parameters.brightness);
    elements.contrastValue.textContent = toPercent(parameters.contrast);
    elements.saturationValue.textContent = toPercent(parameters.saturation);
}

function readManualParameters() {
    return {
        brightness: Number(elements.brightnessRange.value) / 100,
        contrast: Number(elements.contrastRange.value) / 100,
        saturation: Number(elements.saturationRange.value) / 100
    };
}

function setRanges(parameters) {
    elements.brightnessRange.value = Math.round(parameters.brightness * 100);
    elements.contrastRange.value = Math.round(parameters.contrast * 100);
    elements.saturationRange.value = Math.round(parameters.saturation * 100);
    updateRangeLabels();
}

function updateRangeLabels() {
    elements.brightnessRangeValue.textContent = `${elements.brightnessRange.value}%`;
    elements.contrastRangeValue.textContent = `${elements.contrastRange.value}%`;
    elements.saturationRangeValue.textContent = `${elements.saturationRange.value}%`;
}

function setBusy(isBusy) {
    elements.processButton.disabled = isBusy || !processingBlob;
    elements.imageInput.disabled = isBusy;
    elements.applySettingsButton.disabled = isBusy || !modelParameters;
    elements.resetSettingsButton.disabled = isBusy || !modelParameters;
    elements.downloadButton.disabled = isBusy || !resultBlob;

    for (const range of [
        elements.brightnessRange,
        elements.contrastRange,
        elements.saturationRange
    ]) {
        range.disabled = isBusy || !modelParameters;
    }
}

function setSettingsEnabled(enabled) {
    elements.applySettingsButton.disabled = !enabled;
    elements.resetSettingsButton.disabled = !enabled;
    elements.downloadButton.disabled = !enabled || !resultBlob;

    for (const range of [
        elements.brightnessRange,
        elements.contrastRange,
        elements.saturationRange
    ]) {
        range.disabled = !enabled;
    }
}

function downloadResult() {
    if (!resultBlob || !sourceFile) {
        return;
    }

    const link = document.createElement("a");
    const sourceName = sourceFile.name.replace(/\.[^.]+$/, "");
    const extension = outputType === "image/png" ? "png" : "jpg";

    link.href = resultUrl;
    link.download = `${sourceName}-edited.${extension}`;
    link.click();
}

function resetResult() {
    resultBlob = null;
    modelParameters = null;
    releaseResultUrl();
    elements.resultFigure.classList.add("hidden");
    elements.parametersSection.classList.add("hidden");
    elements.progressSection.classList.add("hidden");
    elements.cancelButton.classList.add("hidden");
    elements.progressBar.value = 0;
    elements.progressValue.textContent = "0%";
    setRanges({ brightness: 1, contrast: 1, saturation: 1 });
    setSettingsEnabled(false);
}

function statusText(status, mode) {
    const labels = {
        queued: "В очереди",
        decoding: "Открываем изображение",
        analyzing: "Подбираем настройки",
        processing: mode === "manual" ? "Применяем настройки" : "Обрабатываем изображение",
        encoding: "Сохраняем результат",
        completed: "Готово",
        cancelled: "Отменено",
        error: "Ошибка"
    };

    return labels[status] || status;
}

function getExtension(fileName) {
    return fileName.toLowerCase().split(".").pop();
}

function toPercent(value) {
    return `${Math.round(value * 100)}%`;
}

function showMessage(text, type) {
    elements.message.textContent = text;
    elements.message.className = `message ${type}`;
}

function clearSource() {
    sourceFile = null;
    processingBlob = null;
    outputType = "image/jpeg";
    releaseSourceUrl();
    elements.selectedFileName.textContent = "Файл не выбран";
    elements.originalPreview.removeAttribute("src");
    elements.fileName.textContent = "";
    elements.imageSize.textContent = "";
    elements.imageSection.classList.add("hidden");
    elements.processButton.disabled = true;
}

function releaseSourceUrl() {
    if (sourceUrl) {
        URL.revokeObjectURL(sourceUrl);
        sourceUrl = null;
    }
}

function releaseResultUrl() {
    if (resultUrl) {
        URL.revokeObjectURL(resultUrl);
        resultUrl = null;
    }
}

window.addEventListener("beforeunload", () => {
    releaseSourceUrl();
    releaseResultUrl();
});
