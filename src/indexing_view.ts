import { ItemView, WorkspaceLeaf } from 'obsidian';
import MyPlugin from './main';

export const INDEXING_VIEW_TYPE = 'mcp-indexing-view';

export class IndexingView extends ItemView {
    private plugin: MyPlugin;
    private logContainer: HTMLElement;
    private progressBar: HTMLProgressElement;

    constructor(leaf: WorkspaceLeaf, plugin: MyPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType() {
        return INDEXING_VIEW_TYPE;
    }

    getDisplayText() {
        return 'MCP Indexing';
    }

    async onOpen() {
        const container = this.contentEl;
        container.empty();
        container.createEl('h2', { text: 'MCP Indexing Status' });

        // Status section
        const statusSection = container.createDiv();
        statusSection.createEl('h3', { text: 'Status' });
        // Add status indicators here later

        // Controls section
        const controlsSection = container.createDiv();
        controlsSection.createEl('h3', { text: 'Controls' });
        const startButton = controlsSection.createEl('button', { text: 'Start Indexing' });
        const stopButton = controlsSection.createEl('button', { text: 'Stop Indexing', attr: { disabled: 'true' } });
        const restartServerButton = controlsSection.createEl('button', { text: 'Restart MCP Server' });

        startButton.onClickEvent(() => this.plugin.indexer.startIndexing());
        stopButton.onClickEvent(() => this.plugin.indexer.stopIndexing());
        restartServerButton.onClickEvent(() => this.plugin.mcpServer.restart());

        // Progress section
        const progressSection = container.createDiv();
        progressSection.createEl('h3', { text: 'Progress' });
        this.progressBar = progressSection.createEl('progress');
        this.progressBar.style.width = '100%';

        // Logs section
        const logsSection = container.createDiv();
        logsSection.createEl('h3', { text: 'Logs' });
        this.logContainer = logsSection.createEl('div', { cls: 'mcp-log-container' });
    }

    addLog(message: string) {
        const logLine = this.logContainer.createEl('div', { text: message });
        this.logContainer.scrollTop = this.logContainer.scrollHeight;
    }

    updateProgress(processed: number, total: number) {
        this.progressBar.max = total;
        this.progressBar.value = processed;
    }

    onIndexingStart() {
        this.containerEl.querySelector('button[text="Start Indexing"]')?.setAttribute('disabled', 'true');
        this.containerEl.querySelector('button[text="Stop Indexing"]')?.removeAttribute('disabled');
    }

    onIndexingStop() {
        this.containerEl.querySelector('button[text="Start Indexing"]')?.removeAttribute('disabled');
        this.containerEl.querySelector('button[text="Stop Indexing"]')?.setAttribute('disabled', 'true');
        this.progressBar.value = 0;
    }
}