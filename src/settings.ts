import { App, PluginSettingTab, Setting } from 'obsidian';
import MyPlugin from './main'; // Assuming MyPlugin is the name of the main plugin class

export class MCPSettingsTab extends PluginSettingTab {
    plugin: MyPlugin;

    constructor(app: App, plugin: MyPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();

        containerEl.createEl('h2', { text: 'MCP Settings' });

        new Setting(containerEl)
            .setName('MCP Server Port')
            .setDesc('The port for the MCP server.')
            .addText(text => text
                .setPlaceholder('e.g. 3030')
                .setValue(this.plugin.settings.mcp_port.toString())
                .onChange(async (value) => {
                    this.plugin.settings.mcp_port = Number(value);
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Python Path')
            .setDesc('The path to the Python executable.')
            .addText(text => text
                .setPlaceholder('e.g. /usr/bin/python3')
                .setValue(this.plugin.settings.python_path)
                .onChange(async (value) => {
                    this.plugin.settings.python_path = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Embedding Model')
            .setDesc('The model to use for vectorization.')
            .addDropdown(dropdown => dropdown
                .addOption('all-MiniLM-L6-v2', 'all-MiniLM-L6-v2')
                .setValue(this.plugin.settings.embedding_model)
                .onChange(async (value) => {
                    this.plugin.settings.embedding_model = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Excluded Folders')
            .setDesc('Folders to exclude from indexing (one per line).')
            .addTextArea(text => text
                .setPlaceholder('e.g. private/\ntemplates/')
                .setValue(this.plugin.settings.excluded_folders.join('\n'))
                .onChange(async (value) => {
                    this.plugin.settings.excluded_folders = value.split('\n').map(v => v.trim()).filter(v => v);
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Search default mode')
            .setDesc('Fuse ranking profile: balanced or taxonomy')
            .addDropdown(drop => drop
                .addOption('balanced', 'balanced')
                .addOption('taxonomy', 'taxonomy')
                .addOption('semantic', 'semantic')
                .setValue(this.plugin.settings.search_default_mode || 'balanced')
                .onChange(async (value) => {
                    this.plugin.settings.search_default_mode = value as any;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Include linked notes by default')
            .setDesc('When enabled, search results may include linked notes')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.search_include_linked_default ?? true)
                .onChange(async (value) => {
                    this.plugin.settings.search_include_linked_default = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Default search limit')
            .setDesc('How many items to return by default')
            .addText(text => text
                .setPlaceholder('e.g. 20')
                .setValue(String(this.plugin.settings.search_limit_default ?? 20))
                .onChange(async (value) => {
                    const n = Number(value);
                    this.plugin.settings.search_limit_default = isNaN(n) ? 20 : n;
                    await this.plugin.saveSettings();
                }));
    }
}