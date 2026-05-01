# Librarian AI

Librarian AI is a Chrome extension for reading PDFs in a dedicated viewer, highlighting text, writing notes, and chatting with the document in context.

The project is split into two parts:

- `Librarian AI/` - the extension itself
- `docs/` - the static landing page for the project

## What it does

- Redirects PDF navigation into an extension-controlled viewer
- Renders highlights directly on the PDF page
- Lets you open a sidebar for chat, highlights, and notes
- Supports highlight colors, deletion, and contextual actions
- Keeps notes local to each document
- Uses a local API-key-driven AI bridge for chat when configured

## How to test it

1. Open a terminal in `Librarian AI/`
2. Install dependencies if needed:

```bash
npm install
```

3. Build the extension:

```bash
npm run build
```

4. In Chrome, open `chrome://extensions`
5. Turn on Developer mode
6. Click `Load unpacked`
7. Select the `Librarian AI/dist` folder

After loading it:

- Open a PDF link in Chrome and confirm it redirects into the Librarian viewer
- Select text to create a highlight
- Right-click a rendered highlight to recolor or delete it
- Open the sidebar to test highlights and notes


