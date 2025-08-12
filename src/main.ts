import { Plugin } from 'obsidian';
import { MCPSettings, DEFAULT_SETTINGS } from './types';
import { MCPSettingsTab } from './settings';
import { MCPServer } from './mcp_server';
import { Indexer } from './indexer';
import { IndexingView, INDEXING_VIEW_TYPE } from './indexing_view';
import { spawn } from 'child_process';
import * as fs from 'fs';
import { normalize, dirname } from 'path';

export default class MyPlugin extends Plugin {
    settings: MCPSettings;
    mcpServer: MCPServer;
    indexer: Indexer;
    indexingView: IndexingView;
    workerUrl: string;

    async onload() {
        await this.loadSettings();
        const workerPath = `${this.manifest.dir}/worker.js`;
        const workerBlob = new Blob([await this.app.vault.adapter.read(workerPath)], { type: 'text/javascript' });
        this.workerUrl = URL.createObjectURL(workerBlob);

        this.mcpServer = new MCPServer(this);
        const modelsPath = `${this.manifest.dir}/models`;
        this.indexer = new Indexer(this, modelsPath);

        this.addSettingTab(new MCPSettingsTab(this.app, this));

        this.registerView(
            INDEXING_VIEW_TYPE,
            (leaf) => (this.indexingView = new IndexingView(leaf, this))
        );

        this.addRibbonIcon('brain-circuit', 'Activate MCP Indexing View', () => {
            this.activateView();
        });

        this.addCommand({
            id: 'start-indexing',
            name: 'Start Indexing',
            callback: () => {
                this.indexer.startIndexing();
            },
        });

        await this.setupPythonEnvironment();
        await this.mcpServer.start();
    }

    onunload() {
        this.mcpServer.stop();
        if (this.indexingView) {
            this.indexingView.leaf.detach();
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async setupPythonEnvironment() {
        // ...
    }

    async activateView() {
        this.app.workspace.detachLeavesOfType(INDEXING_VIEW_TYPE);

        const leaf = this.app.workspace.getRightLeaf(false);
        if (leaf) {
            await leaf.setViewState({
                type: INDEXING_VIEW_TYPE,
                active: true,
            });

            this.app.workspace.revealLeaf(leaf);
        }
    }
}