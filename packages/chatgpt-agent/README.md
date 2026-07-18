# chatgpt-agent (OpenCLI plugin)

Protocol-first ChatGPT web adapter:

1. Arm WS capture → send composer message  
2. Collect stream text / sandbox files / image gen pointers  
3. Files: human-like chip / flyout Download via `waitForDownload`  
4. Images: official-style DOM export (fetch/canvas → local files)  
5. Uploads: sequential `setFileInput` (path) with DataTransfer fallback  

Depends on host `@jackwener/opencli` and its built-in `clis/chatgpt/utils.js` (resolved at runtime via `host-chatgpt.js`).
