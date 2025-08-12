export interface MCPSettings {
    mcp_port: number;
    python_path: string;
    embedding_model: string;
    excluded_folders: string[];
}

export const DEFAULT_SETTINGS: MCPSettings = {
    mcp_port: 3030,
   python_path: 'python3',
    embedding_model: 'all-MiniLM-L6-v2',
    excluded_folders: [],
};

export interface IndexedFile {
    path: string;
    content_preview: string;
    vector: number[];
}