import { IndexedFile } from './types';

self.onmessage = async (event: MessageEvent) => {
    const { type, files, model, mcpPort } = event.data;

    if (type === 'start') {
        try {
            self.postMessage({ type: 'log', message: 'Starting indexing using existing index.json (no vectorization)...' });

            const indexedFiles: IndexedFile[] = [];
            const total = files.length;

            for (let i = 0; i < total; i++) {
                const file = files[i];
                
                try {
                    // Skip vectorization since we use existing index.json
                    // The new TypeScript MCP server reads from index.json directly
                    indexedFiles.push({
                        path: file.path,
                        content_preview: file.content.slice(0, 300) + '...',
                        vector: [], // No vectorization needed - empty array
                    });

                    self.postMessage({ type: 'progress', processed: i + 1, total });

                } catch (error) {
                    self.postMessage({ 
                        type: 'log', 
                        message: `Failed to process ${file.path}: ${error.message}` 
                    });
                    // Continue with next file instead of failing completely
                    continue;
                }
            }

            self.postMessage({ type: 'result', indexedFiles });

        } catch (error) {
            self.postMessage({
                type: 'error',
                error: {
                    message: error.message,
                    stack: error.stack,
                    name: error.name,
                }
            });
        }
    }
};