import { App, TFile, DataAdapter, normalizePath } from 'obsidian';
import MyPlugin from './main';
import { IndexedFile } from './types';

export class Indexer {
    private plugin: MyPlugin;
    private worker: Worker | null = null;
    public isIndexing: boolean = false;
    private modelsPath: string;

    constructor(plugin: MyPlugin, modelsPath: string) {
        this.plugin = plugin;
        this.modelsPath = modelsPath; // Этот параметр больше не используется для воркера, но оставим для порядка
    }

    async startIndexing() {
    if (this.isIndexing) {
        this.plugin.indexingView?.addLog('Indexing is already in progress.');
        return;
    }

    this.isIndexing = true;
    this.plugin.indexingView?.onIndexingStart();

    // --- НАЧАЛО ФИНАЛЬНОГО ИСПРАВЛЕНИЯ ---

    const pluginRelativePath = this.plugin.manifest.dir;

    if (!pluginRelativePath) {
        const errorMessage = "Plugin directory is not available. Cannot start indexing.";
        this.plugin.indexingView?.addLog(`[Indexer ERROR]: ${errorMessage}`);
        this.stopIndexing();
        return;
    }

    // `getResourcePath` как раз и ожидает путь относительно корня хранилища.
    // `manifest.dir` именно его и предоставляет.
    const pluginRootUrl = this.plugin.app.vault.adapter.getResourcePath(pluginRelativePath);

    this.plugin.indexingView?.addLog(`Plugin root URL for worker: ${pluginRootUrl}`);

    // --- КОНЕЦ ФИНАЛЬНОГО ИСПРАВЛЕНИЯ ---

    this.worker = new Worker(this.plugin.workerUrl, { type: 'module' });

    this.worker.onmessage = async (event) => {
        const { type, message, processed, total, indexedFiles, error } = event.data;

        switch (type) {
            case 'log':
                this.plugin.indexingView?.addLog(`[Indexer Worker]: ${message}`);
                break;
            case 'progress':
                this.plugin.indexingView?.updateProgress(processed, total);
                break;
            case 'result':
                await this.saveIndex(indexedFiles);
                this.plugin.indexingView?.addLog('Indexing finished successfully.');
                this.stopIndexing();
                break;
            case 'error':
                this.plugin.indexingView?.addLog(`[Indexer Worker ERROR]: ${error.message}\n${error.stack}`);
                this.stopIndexing();
                break;
        }
    };

    this.worker.onerror = (event: ErrorEvent) => {
        event.preventDefault();
        const errorMessage = event.message || 'An unknown error occurred';
        this.plugin.indexingView?.addLog(`[Indexer Worker ERROR]: ${errorMessage}`);
        console.error('Full error event:', event);
        this.stopIndexing();
    };

    const filesToIndex = await this.prepareFiles();
    this.worker.postMessage({
        type: 'start',
        files: filesToIndex,
        model: this.plugin.settings.embedding_model,
        mcpPort: this.plugin.settings.mcp_port, // Передаем порт MCP-сервера
    });
}

    // ВОТ ЭТОТ МЕТОД БЫЛ ПОТЕРЯН. Я ЕГО ВЕРНУЛ.
    public stopIndexing() {
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }
        this.isIndexing = false;
        this.plugin.indexingView?.onIndexingStop();
    }

    private async prepareFiles(): Promise<{ path: string, content: string }[]> {
        const files = this.plugin.app.vault.getMarkdownFiles();
        const excludedFolders = this.plugin.settings.excluded_folders;

        const filesToProcess = files.filter(file =>
            !excludedFolders.some(folder => file.path.startsWith(folder))
        );

        const fileContents = await Promise.all(
            filesToProcess.map(async (file) => ({
                path: file.path,
                content: await this.plugin.app.vault.cachedRead(file),
            }))
        );

        return fileContents;
    }

    private async saveIndex(indexedFiles: IndexedFile[]) {
        const indexPath = `${this.plugin.app.vault.configDir}/plugins/obsidian-mcp-plugin/index.json`;
        await this.plugin.app.vault.adapter.write(indexPath, JSON.stringify(indexedFiles, null, 2));
    }
}