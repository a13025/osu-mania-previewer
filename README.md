# osu!mania Previewer

A browser-based tool for previewing and exporting osu!mania charts. It lets you import `.osu` files, `.osz` archives, or an entire chart folder, choose a difficulty, preview it in real time, and export either a still image or a rendered video.

This project is built with React, Vite, and TypeScript, and runs entirely in the browser.

## Features

- Drag-and-drop import for `.osu`, `.osz`, `.zip`, and chart folders
- Supports 4K mania chart detection and difficulty switching
- Real-time preview with adjustable fall speed and playback timing
- Optional background image, background music, and SV display toggle
- Export a single frame as PNG
- Export a rendered chart segment or full chart as MP4
- Custom save directory support when the browser exposes `showDirectoryPicker`
- Includes a Python version of the preview generator for reference/export workflows

## Supported inputs

The app accepts:

- `.osu` files
- `.osz` archives
- directories containing chart assets
- audio/image files bundled with the chart

It is intended for osu!mania 4K charts and will ignore unsupported difficulties or charts that cannot be rendered.

## Tech stack

- React 19
- TypeScript
- Vite
- Tailwind CSS
- Browser APIs for media decoding and file export

## Local development

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start the dev server:

   ```bash
   npm run dev
   ```

3. Build for production:

   ```bash
   npm run build
   ```

4. Preview the production build locally:

   ```bash
   npm run preview
   ```

## How to use

1. Open the app in the browser.
2. Drag a chart onto the canvas or click "导入 osu/osz" / "文件夹".
3. Select a 4K mania difficulty from the dropdown.
4. Adjust playback options such as speed, start time, duration, background, and music.
5. Use the play controls to preview the chart.
6. Click "导出图片" to save a frame or "导出视频" to render a video.

## Notes

- The app is optimized for browser-based chart preview and export.
- If a chart includes no audio or background image, those toggles will be disabled automatically.
- For a more scripting-oriented workflow, the project also includes a downloadable Python file (`osumania_preview_v0.7.py`).

## License

This repository does not currently declare a license file. Please check the repository settings or package metadata before using it in production or redistributing it.
