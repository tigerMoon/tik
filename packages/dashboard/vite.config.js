import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
    plugins: [react()],
    resolve: {
        extensions: ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.json'],
    },
    build: {
        chunkSizeWarningLimit: 700,
        rollupOptions: {
            output: {
                manualChunks: {
                    'react-vendor': ['react', 'react-dom', 'zustand'],
                },
            },
        },
    },
    server: {
        port: 5173,
        proxy: {
            '/api': 'http://127.0.0.1:3300',
        },
    },
});
//# sourceMappingURL=vite.config.js.map
