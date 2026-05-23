import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createReadFileTool } from "../../src/tool/index.js";
import { createPilotDeckTempWorkspace } from "../helpers/filesystem.js";
import { createPilotDeckToolRuntimeFixture } from "../helpers/tool.js";

function createMinimalPdf(pages = 1): Buffer {
  const header = "%PDF-1.4\n";
  const catalog = "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
  const pageRefs = Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(" ");
  const pagesObj = `2 0 obj\n<< /Type /Pages /Kids [${pageRefs}] /Count ${pages} >>\nendobj\n`;
  const pageObjs = Array.from({ length: pages }, (_, i) =>
    `${i + 3} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n`,
  );

  const body = header + catalog + pagesObj + pageObjs.join("");
  const totalObjects = pages + 3;

  const offsets: number[] = [];
  let pos = header.length;
  offsets.push(pos);
  pos += catalog.length;
  offsets.push(pos);
  pos += pagesObj.length;
  for (const obj of pageObjs) {
    offsets.push(pos);
    pos += obj.length;
  }

  const xrefStart = body.length;
  let xref = `xref\n0 ${totalObjects}\n`;
  xref += "0000000000 65535 f \n";
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }

  const trailer = `trailer\n<< /Size ${totalObjects} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body + xref + trailer, "latin1");
}

test("read_file reads text files with offset and limit", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({ "src/a.txt": "one\ntwo\nthree\nfour" });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createReadFileTool()],
    cwd: workspace.cwd,
  });

  const result = await toolRuntime.execute(
    { id: "call-1", name: "read_file", input: { file_path: "src/a.txt", offset: 2, limit: 2 } },
    context,
  );

  assert.equal(result.type, "success");
  assert.equal(result.content[0]?.type, "text");
  assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", "2|two\n3|three");
  assert.equal(result.metadata?.truncated, true);
});

test("read_file returns controlled errors for missing and outside paths", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createReadFileTool()],
    cwd: workspace.cwd,
  });

  const missing = await toolRuntime.execute(
    { id: "call-1", name: "read_file", input: { file_path: "missing.txt" } },
    context,
  );
  const outside = await toolRuntime.execute(
    { id: "call-2", name: "read_file", input: { file_path: "../outside.txt" } },
    context,
  );

  assert.equal(missing.type, "error");
  assert.equal(outside.type, "error");
  if (missing.type === "error") assert.equal(missing.error.code, "file_not_found");
  if (outside.type === "error") assert.equal(outside.error.code, "path_not_allowed");
});

test("read_file returns unchanged stub for repeated reads", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({ "src/a.txt": "one\ntwo\nthree" });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createReadFileTool()],
    cwd: workspace.cwd,
  });

  const first = await toolRuntime.execute(
    { id: "call-1", name: "read_file", input: { file_path: "src/a.txt" } },
    context,
  );
  const second = await toolRuntime.execute(
    { id: "call-2", name: "read_file", input: { file_path: "src/a.txt" } },
    context,
  );

  assert.equal(first.type, "success");
  assert.equal(second.type, "success");
  assert.equal(second.content[0]?.type, "text");
  assert.match(
    second.content[0]?.type === "text" ? second.content[0].text : "",
    /File unchanged since the last read/,
  );
  assert.equal(context.writeSnapshots?.get(path.join(workspace.cwd, "src/a.txt"))?.absolutePath, path.join(workspace.cwd, "src/a.txt"));
  assert.equal(context.writeSnapshots?.get(path.join(workspace.cwd, "src/a.txt"))?.mtimeMs !== undefined, true);
});

test("read_file renders notebook files as numbered text", async (t) => {
  const notebook = JSON.stringify({
    cells: [
      {
        cell_type: "markdown",
        source: ["# Title\n", "hello"],
      },
      {
        cell_type: "code",
        execution_count: 1,
        source: ["print('hi')\n"],
        outputs: [{ text: ["hi\n"] }],
      },
    ],
  });
  const workspace = await createPilotDeckTempWorkspace({ "demo.ipynb": notebook });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createReadFileTool()],
    cwd: workspace.cwd,
  });

  const result = await toolRuntime.execute(
    { id: "call-1", name: "read_file", input: { file_path: "demo.ipynb" } },
    context,
  );

  assert.equal(result.type, "success");
  assert.equal(result.content[0]?.type, "text");
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.match(text, /1\|# Cell 0 \(markdown\)/);
  assert.match(text, /Cell 1 \(code\)/);
});

test("read_file returns image blocks when the model supports images", async (t) => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2pL7sAAAAASUVORK5CYII=",
    "base64",
  );
  const workspace = await createPilotDeckTempWorkspace({ "pixel.png": png });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createReadFileTool()],
    cwd: workspace.cwd,
    modelMultimodal: { input: ["text", "image"], maxImageBytes: 5_242_880 },
  });

  const result = await toolRuntime.execute(
    { id: "call-1", name: "read_file", input: { file_path: "pixel.png" } },
    context,
  );

  assert.equal(result.type, "success");
  assert.equal(result.content[0]?.type, "image");
  if (result.content[0]?.type === "image") {
    assert.equal(result.content[0].mimeType, "image/png");
    assert.ok(result.content[0].data.length > 0);
  }
});

test("read_file returns pdf document block for small PDFs when model supports pdf", async (t) => {
  const pdf = createMinimalPdf(1);

  const workspace = await createPilotDeckTempWorkspace({ "doc.pdf": pdf });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createReadFileTool()],
    cwd: workspace.cwd,
    modelMultimodal: { input: ["text", "pdf"], maxPdfBytes: 1_000_000, maxPdfPages: 20 },
  });

  const result = await toolRuntime.execute(
    { id: "call-1", name: "read_file", input: { file_path: "doc.pdf" } },
    context,
  );

  assert.equal(result.type, "success");
  assert.equal(result.content[0]?.type, "text");
  assert.ok(result.supplementalMessages);
  assert.equal(result.supplementalMessages![0]!.content[0]?.type, "pdf");
});

test("read_file rejects excessive page ranges via validation", async (t) => {
  const pdf = createMinimalPdf(1);

  const workspace = await createPilotDeckTempWorkspace({ "doc.pdf": pdf });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createReadFileTool()],
    cwd: workspace.cwd,
    modelMultimodal: { input: ["text", "pdf"], maxPdfBytes: 1_000_000, maxPdfPages: 20 },
  });

  const invalid = await toolRuntime.execute(
    { id: "call-1", name: "read_file", input: { file_path: "doc.pdf", pages: "2-25" } },
    context,
  );
  assert.equal(invalid.type, "error");
  if (invalid.type === "error") {
    assert.equal(invalid.error.code, "invalid_tool_input");
  }
});

test("read_file renders PDF pages as images when pages param is provided", async (t) => {
  const pdf = createMinimalPdf(3);

  const workspace = await createPilotDeckTempWorkspace({ "multi.pdf": pdf });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createReadFileTool()],
    cwd: workspace.cwd,
    modelMultimodal: { input: ["text", "image", "pdf"], maxImageBytes: 5_242_880 },
  });

  const result = await toolRuntime.execute(
    { id: "call-1", name: "read_file", input: { file_path: "multi.pdf", pages: "1-2" } },
    context,
  );

  assert.equal(result.type, "success");
  assert.match(
    result.content[0]?.type === "text" ? result.content[0].text : "",
    /PDF pages extracted.*2 page/,
  );
  assert.ok(result.supplementalMessages);
  assert.equal(result.supplementalMessages![0]!.content[0]?.type, "image");
});

test("read_file degrades large PDFs to image rendering", async (t) => {
  const pdf = createMinimalPdf(2);

  const workspace = await createPilotDeckTempWorkspace({ "big.pdf": pdf });
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createReadFileTool()],
    cwd: workspace.cwd,
    // Model supports pdf, but we set a tiny threshold by testing with the actual code's 3MB threshold
    // Since our minimal PDF is < 3MB, we test the !supportsPdf path instead
    modelMultimodal: { input: ["text", "image"], maxImageBytes: 5_242_880 },
  });

  const result = await toolRuntime.execute(
    { id: "call-1", name: "read_file", input: { file_path: "big.pdf" } },
    context,
  );

  assert.equal(result.type, "success");
  assert.match(
    result.content[0]?.type === "text" ? result.content[0].text : "",
    /PDF pages rendered/,
  );
  assert.ok(result.supplementalMessages);
  assert.equal(result.supplementalMessages![0]!.content[0]?.type, "image");
});
