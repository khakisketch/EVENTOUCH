"use client";

// Notice body editor: Tiptap on a deliberately small schema (paragraphs, bold,
// italic, bullet and numbered lists, links, event pictures). The document is
// stored as Markdown (lib/rich-text.ts parses and renders it everywhere), so
// a plain-text notice from before this editor opens as is. A picture is an
// uploaded event file referenced as ![alt](file:<id>); it is never a URL, a
// data URI or raw HTML, and the server re-checks every reference on save.

import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { Markdown } from "@tiptap/markdown";
import { safeHref } from "../../../../../lib/rich-text";
import { fitImage } from "../../../../../lib/image-fit";
import styles from "./rich-editor.module.css";

const FILE_ID = /^[A-Za-z0-9_-]{1,160}$/;

type Props = {
  /** Applied to the editable surface so a label and an error can point at it. */
  id: string;
  labelledBy: string;
  describedBy?: string;
  invalid?: boolean;
  value: string;
  onChange: (markdown: string) => void;
  disabled?: boolean;
  /** Resolves an uploaded file id to a URL this operator can fetch. */
  imageSrc: (fileId: string) => string;
  /** Uploads a picture and returns its stored file id; throws a user-facing Error. */
  uploadImage: (file: File) => Promise<{ fileId: string; name: string }>;
};

function ToolIcon({ name }: { name: "bold" | "italic" | "bullets" | "numbers" | "link" | "image" }) {
  const paths: Record<typeof name, string> = {
    bold: "M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z",
    italic: "M10 5h8M6 19h8M14 5l-4 14",
    bullets: "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01",
    numbers: "M10 6h10M10 12h10M10 18h10M4 5l1.5-1v4M4 13.5c0-1 2.5-1 2.5.3S4 15 4 16.5h2.8M4 20c1 .8 2.8.5 2.8-.5S5.5 18.6 5 18.6c.6 0 1.7-.2 1.7-1.1S5 16.6 4 17.3",
    link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1",
    image: "M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5zM9 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM20 16l-4.5-4.5L7 20",
  };
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={paths[name]} />
    </svg>
  );
}

export default function RichEditor({ id, labelledBy, describedBy, invalid, value, onChange, disabled = false, imageSrc, uploadImage }: Props) {
  const [uploading, setUploading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("");
  const fileInput = useRef<HTMLInputElement | null>(null);
  const lastEmitted = useRef(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const imageSrcRef = useRef(imageSrc);
  imageSrcRef.current = imageSrc;
  const uploadRef = useRef(uploadImage);
  uploadRef.current = uploadImage;
  const editorRef = useRef<Editor | null>(null);

  async function addImages(files: File[]) {
    const editor = editorRef.current;
    if (!editor || !files.length) return;
    setProblem(null);
    setUploading(true);
    try {
      for (const original of files) {
        const fitted = await fitImage(original);
        if ("error" in fitted) { setProblem(fitted.error); continue; }
        const uploaded = await uploadRef.current(fitted.file);
        if (!FILE_ID.test(uploaded.fileId)) { setProblem("이미지 업로드 결과를 확인하지 못했습니다."); continue; }
        const alt = uploaded.name.replace(/\.[^.]+$/, "").replace(/[[\]\n]/g, " ").slice(0, 80);
        editor.chain().focus().insertContent({ type: "image", attrs: { fileId: uploaded.fileId, alt } }).run();
      }
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "이미지를 올리지 못했습니다.");
    } finally {
      setUploading(false);
    }
  }
  const addImagesRef = useRef(addImages);
  addImagesRef.current = addImages;

  const editor = useEditor({
    immediatelyRender: false,
    editable: !disabled,
    extensions: [
      StarterKit.configure({
        // The stored subset: nothing else can be typed, pasted or dropped in.
        heading: false, blockquote: false, code: false, codeBlock: false, horizontalRule: false, strike: false, underline: false,
        link: { openOnClick: false, autolink: true, linkOnPaste: true, isAllowedUri: (url: string) => Boolean(safeHref(url)), HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" } },
      }),
      // An event picture: file id in, ![alt](file:id) out. Foreign <img> markup is ignored.
      Image.extend({
        addAttributes() {
          return {
            fileId: { default: null, parseHTML: (element: HTMLElement) => element.getAttribute("data-file-id"), renderHTML: (attrs: Record<string, unknown>) => (attrs.fileId ? { "data-file-id": attrs.fileId, src: imageSrcRef.current(String(attrs.fileId)) } : {}) },
            alt: { default: "" },
          };
        },
        parseHTML() { return [{ tag: "img[data-file-id]" }]; },
        parseMarkdown: (token, helpers) => {
          const href = String((token as { href?: string }).href ?? "");
          const text = String((token as { text?: string }).text ?? "");
          const fileId = href.startsWith("file:") ? href.slice(5) : "";
          // A foreign URL is not an event picture: keep its words, drop the fetch.
          return FILE_ID.test(fileId) ? helpers.createNode("image", { fileId, alt: text }) : helpers.createNode("text", { text });
        },
        renderMarkdown: (node: { attrs?: Record<string, unknown> }) => `![${String(node.attrs?.alt ?? "").replace(/[[\]\n]/g, " ")}](file:${String(node.attrs?.fileId ?? "")})`,
      }).configure({ allowBase64: false }),
      Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
    ],
    content: value,
    contentType: "markdown",
    editorProps: {
      attributes: {
        id,
        role: "textbox",
        "aria-multiline": "true",
        "aria-labelledby": labelledBy,
        ...(describedBy ? { "aria-describedby": describedBy } : {}),
        ...(invalid ? { "aria-invalid": "true" } : {}),
        class: styles.surface,
      },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
        if (!files.length) return false;
        event.preventDefault();
        void addImagesRef.current(files);
        return true;
      },
      handleDrop: (_view, event) => {
        const files = Array.from(event.dataTransfer?.files ?? []).filter((file) => file.type.startsWith("image/"));
        if (!files.length) return false;
        event.preventDefault();
        void addImagesRef.current(files);
        return true;
      },
    },
    onUpdate: ({ editor: current }) => {
      // Empty paragraphs serialize as &nbsp; and stack blank lines; neither is content.
      const markdown = current.getMarkdown().replace(/^&nbsp;[ \t]*$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
      lastEmitted.current = markdown;
      onChangeRef.current(markdown);
    },
  });
  editorRef.current = editor;

  // The caller replaced the text (a reloaded draft, another item): follow it.
  // Our own edits echo back unchanged and are skipped.
  useEffect(() => {
    if (!editor || value === lastEmitted.current) return;
    lastEmitted.current = value;
    editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
  }, [editor, value]);
  useEffect(() => { editor?.setEditable(!disabled); }, [editor, disabled]);

  if (!editor) return <div className={styles.shell} aria-busy="true"><div className={styles.toolbar} /><div className={styles.surface} /></div>;

  const tool = (label: string, icon: Parameters<typeof ToolIcon>[0]["name"], active: boolean, run: () => void, extra?: { disabled?: boolean }) => (
    <button type="button" className={styles.tool} aria-label={label} title={label} aria-pressed={active} disabled={disabled || extra?.disabled} onMouseDown={(event) => event.preventDefault()} onClick={run}>
      <ToolIcon name={icon} />
    </button>
  );

  function applyLink() {
    const href = safeHref(linkValue.trim() && !/^[a-z]+:/i.test(linkValue.trim()) ? `https://${linkValue.trim()}` : linkValue);
    if (!href) { setProblem("http(s) 주소, 메일 주소, 전화번호만 연결할 수 있습니다."); return; }
    setProblem(null);
    if (editor && editor.state.selection.empty && !editor.isActive("link")) {
      // Nothing selected: the address itself becomes the link text.
      editor.chain().focus().insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] }).run();
    } else {
      editor?.chain().focus().extendMarkRange("link").setLink({ href }).run();
    }
    setLinkOpen(false);
  }

  return (
    <div className={styles.shell} data-invalid={invalid || undefined}>
      <div className={styles.toolbar} role="toolbar" aria-label="서식" aria-controls={id}>
        {tool("굵게", "bold", editor.isActive("bold"), () => editor.chain().focus().toggleBold().run())}
        {tool("기울임", "italic", editor.isActive("italic"), () => editor.chain().focus().toggleItalic().run())}
        <span className={styles.rule} aria-hidden="true" />
        {tool("글머리 목록", "bullets", editor.isActive("bulletList"), () => editor.chain().focus().toggleBulletList().run())}
        {tool("번호 목록", "numbers", editor.isActive("orderedList"), () => editor.chain().focus().toggleOrderedList().run())}
        <span className={styles.rule} aria-hidden="true" />
        {tool("링크", "link", editor.isActive("link") || linkOpen, () => {
          setProblem(null);
          setLinkValue(String(editor.getAttributes("link").href ?? ""));
          setLinkOpen((open) => !open);
        })}
        {tool(uploading ? "이미지 올리는 중" : "이미지 넣기", "image", false, () => fileInput.current?.click(), { disabled: uploading })}
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          void addImages(files);
        }} />
      </div>
      {linkOpen ? (
        <div className={styles.linkRow}>
          <input
            type="text"
            inputMode="url"
            className={styles.linkInput}
            aria-label="링크 주소"
            placeholder="https://"
            value={linkValue}
            onChange={(event) => setLinkValue(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); applyLink(); } if (event.key === "Escape") { event.preventDefault(); setLinkOpen(false); editor.commands.focus(); } }}
            autoFocus
          />
          <button type="button" className={styles.linkAction} onClick={applyLink}>적용</button>
          {editor.isActive("link") ? <button type="button" className={styles.linkAction} onClick={() => { editor.chain().focus().extendMarkRange("link").unsetLink().run(); setLinkOpen(false); }}>해제</button> : null}
        </div>
      ) : null}
      <EditorContent editor={editor} />
      {uploading ? <p className={styles.status} role="status">이미지를 올리고 있습니다.</p> : null}
      {problem ? <p className={styles.problem} role="alert">{problem}</p> : null}
    </div>
  );
}
