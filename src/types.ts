export interface MCPSettings {
    mcp_port: number;
    python_path: string;
    embedding_model: string;
    excluded_folders: string[];
    search_default_mode?: 'balanced' | 'taxonomy';
    search_include_linked_default?: boolean;
    search_limit_default?: number;
}

export const DEFAULT_SETTINGS: MCPSettings = {
    mcp_port: 3030,
   python_path: 'python3',
    embedding_model: 'all-MiniLM-L6-v2',
    excluded_folders: [
        '.git',
        'node_modules',
        'dist',
        'build',
        '.venv',
        'venv',
        '.obsidian/plugins/obsidian-mcp-plugin/.venv',
        '.obsidian/plugins/obsidian-mcp-plugin/venv',
        '.obsidian/plugins/obsidian-mcp-plugin/node_modules',
        '.obsidian/plugins/obsidian-mcp-plugin/dist',
        '.obsidian/plugins/obsidian-mcp-plugin/models',
        '.obsidian/plugins/obsidian-mcp-plugin/onnx',
        '.obsidian/plugins/obsidian-mcp-plugin/openvino'
    ],
    search_default_mode: 'balanced',
    search_include_linked_default: true,
    search_limit_default: 20,
};

export interface IndexedFile {
    path: string;
    content_preview: string;
    vector: number[];
}