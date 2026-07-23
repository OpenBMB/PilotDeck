type HtmlDocumentPreviewProps = {
  url: string;
  title: string;
};

export default function HtmlDocumentPreview({ url, title }: HtmlDocumentPreviewProps) {
  return (
    <iframe
      className="h-full w-full border-0 bg-white"
      src={url}
      title={title}
      sandbox="allow-forms allow-modals allow-popups allow-scripts"
      referrerPolicy="no-referrer"
    />
  );
}
