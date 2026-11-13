const { readFile } = await import("node:fs/promises");
const request = JSON.parse(await readFile(inputPath, "utf8"));
const task = await taskSpace(request.space);
const page = task.page(request.page);
const settings = "button.settings-trigger-button";
const picker = "flow-prompt-box-settings .settings-content > button.mat-mdc-menu-trigger";
const editor = ".ProseMirror[contenteditable=true]";
const generate = "button.generate-icon-button[type=submit]";
const grid = "flow-grid-tile-container";
const flow = "https://flow.google.com";
const projectId = () => new URL(pageUrl).pathname.match(/^\/project\/([a-z0-9-]+)\/?$/i)?.[1];
let pageUrl = await page.url();
let submitted = false;

async function click(selector, label) {
  await page.waitForSelector(selector, { timeout: 12000 });
  await page.click(selector, { label });
}

async function chooseRadio(value, icon) {
  await page.waitForFunction(({ value, icon }) =>
    [...document.querySelectorAll("flow-prompt-box-settings [role=radio]")]
      .some(el => el.getClientRects().length && (icon
        ? el.querySelector("mat-icon")?.textContent.trim() === value
        : (el.querySelector(".toggle-text") ?? el).textContent.trim() === value)),
  { value, icon }, { timeout: 8000 });
  const id = await page.evaluate(({ value, icon }) => {
    const items = [...document.querySelectorAll("flow-prompt-box-settings [role=radio]")]
      .filter(el => el.getClientRects().length && (icon
        ? el.querySelector("mat-icon")?.textContent.trim() === value
        : (el.querySelector(".toggle-text") ?? el).textContent.trim() === value));
    if (items.length !== 1) throw new Error("Flow does not offer a unique option: " + value);
    return items[0].id;
  }, { value, icon });
  const selector = "[id=" + JSON.stringify(id) + "]";
  const checked = () => page.evaluate(s =>
    document.querySelector(s)?.getAttribute("aria-checked") === "true", selector);
  if (!(await checked())) await click(selector, "Set Flow video option");
  if (!(await checked())) throw new Error("Flow did not apply option: " + value);
}

async function bindFrame(index, path) {
  const slot = ".ingredient-bar-container > .frame-trigger:" + (index ? "last-child" : "first-child");
  const bound = slot + " .chip-container[aria-busy=false] img.chip-image";
  await click(slot + " .empty-chip", index ? "Open end frame picker" : "Open start frame picker");
  const filename = path.split("/").at(-1);
  const upload = "button.sidebar-upload-btn";
  await page.waitForSelector(upload, { timeout: 12000 });
  const [chooser] = await Promise.all([
    page.waitForFileChooser({ timeout: 10000 }),
    page.click(upload, { label: "Upload frame image file" }),
  ]);
  const receipt = await chooser.setFiles(path);
  if (receipt.dialog) throw new Error("Flow opened a dialog during frame upload");
  // Flow can bind a newly uploaded file directly and close the picker.
  await page.waitForFunction(({ bound, filename }) => Boolean(document.querySelector(bound)) ||
    [...document.querySelectorAll("button.asset-item")].some(el =>
      el.querySelector(".asset-title")?.textContent.trim() === filename &&
      el.querySelector("img")?.naturalWidth > 0), { bound, filename }, { timeout: 60000 });
  if (await page.evaluate(selector => Boolean(document.querySelector(selector)), bound)) {
    console.error(index ? "End frame bound." : "Start frame bound.");
    return;
  }
  const assetIndex = await page.evaluate(name => {
    const items = [...document.querySelectorAll("button.asset-item")];
    const matches = items.filter(el => el.querySelector(".asset-title")?.textContent.trim() === name);
    if (matches.length !== 1) throw new Error("Uploaded frame could not be identified");
    return items.indexOf(matches[0]);
  }, filename);
  await page.click("button.asset-item >> nth=" + assetIndex,
    { label: "Select newly uploaded frame" });
  await page.waitForFunction(name =>
    [...document.querySelectorAll("button.asset-item[aria-selected=true]")]
      .some(el => el.querySelector(".asset-title")?.textContent.trim() === name &&
        el.querySelector("img")?.complete && el.querySelector("img")?.naturalWidth > 0),
  filename, { timeout: 60000 });
  await click("button.detail-add-to-prompt-btn", "Bind uploaded frame image");
  await page.waitForSelector(bound, { timeout: 15000 });
  console.error(index ? "End frame bound." : "Start frame bound.");
}

try {
  if (new URL(pageUrl).origin !== flow) throw new Error("Open Google Flow in the chosen Ego Lite tab");
  if (request.project) {
    if (projectId() !== request.project) await page.goto(flow + "/project/" + request.project);
  } else {
    if (new URL(pageUrl).pathname !== "/") await page.goto(flow + "/");
    await click("flow-projects-page button.new-project-button", "Create a Flow project");
    await page.waitForURL("**/project/**", { timeout: 30000 });
  }
  pageUrl = await page.url();
  if (!projectId() || (request.project && projectId() !== request.project)) {
    throw new Error("The requested Flow project did not open");
  }
  const project = projectId();
  await page.waitForSelector(editor, { timeout: 20000 });
  if (await page.evaluate(s =>
    Boolean(document.querySelector(s)?.textContent.trim() ||
      document.querySelector(".ingredient-bar-container .chip-container")), editor)) {
    throw new Error("The editor contains a draft. Clear it or use a separate Flow project");
  }
  if (!request.project) {
    const title = "flow-editable-text input";
    await page.fill(title, request.title);
    await page.press(title, "Enter");
  }
  const agentMode = "button.agent-mode-chip[aria-pressed=true]";
  if (await page.evaluate(selector => Boolean(document.querySelector(selector)), agentMode)) {
    await click(agentMode, "Open the frame editor");
  }
  if (!(await page.evaluate(() => Boolean(document.querySelector("flow-prompt-box-settings"))))) {
    await click(settings, "Open Flow video settings");
  }
  await chooseRadio("videocam", true);
  await chooseRadio("crop_free", true);
  const matchesModel = async () => page.evaluate(({ selector, label, exclude }) => {
    const text = document.querySelector(selector)?.textContent ?? "";
    return text.includes(label) && (!exclude || !text.includes(exclude));
  }, { selector: picker, label: request.model, exclude: request.exclude });
  if (!(await matchesModel())) {
    await click(picker, "Open Flow model picker");
    const selector = await page.evaluate(({ label, exclude }) => {
      const items = [...document.querySelectorAll("[role=menuitem]")]
        .filter(el => el.getClientRects().length);
      const hits = items.filter(el => el.textContent.includes(label) &&
        (!exclude || !el.textContent.includes(exclude)));
      if (hits.length !== 1) throw new Error("Requested video model is unavailable or ambiguous");
      return "[role=menuitem] >> nth=" + items.indexOf(hits[0]);
    }, request);
    await click(selector, "Select requested video model");
    if (!(await matchesModel())) {
      // Some model families open a submenu containing the selectable variant.
      const nested = await page.evaluate(() =>
        [...document.querySelectorAll(".mat-mdc-menu-panel")].filter(el => el.getClientRects().length)
          .at(-1)?.querySelectorAll("[role=menuitem]").length);
      if (nested !== 1) throw new Error("Requested model variant could not be verified");
      await click(".mat-mdc-menu-panel:last-of-type [role=menuitem]",
        "Select offered model variant");
    }
    if (!(await matchesModel())) throw new Error("Flow did not apply the requested model");
  }
  await chooseRadio(request.aspect === "16:9" ? "crop_16_9" : "crop_9_16", true);
  await chooseRadio("x1", false);
  if (request.resolution) await chooseRadio(request.resolution, false);
  if (request.duration) {
    const slider = "flow-duration-slider input[type=range]";
    const range = await page.evaluate(s => {
      const el = document.querySelector(s);
      return el && { min: Number(el.min), max: Number(el.max), value: Number(el.value) };
    }, slider);
    if (range && request.model === "Omni 1.2 Flash") {
      const index = request.duration - 3;
      if (range.min !== 0 || ![7, 12].includes(range.max) || index > range.max) {
        throw new Error("Requested Flow duration is unavailable");
      }
      const key = index < range.value ? "ArrowLeft" : "ArrowRight";
      for (let i = 0; i < Math.abs(index - range.value); i++) await page.press(slider, key);
      const actual = await page.evaluate(() =>
        document.querySelector(".duration-slider-value")?.textContent.match(/\d+/)?.[0]);
      if (Number(actual) !== request.duration) throw new Error("Flow duration did not apply");
    } else {
      const duration = await page.evaluate(seconds => {
        const items = [...document.querySelectorAll("flow-prompt-box-settings [role=radio]")];
        const group = items.filter(el => el.closest("flow-duration-slider") === null &&
          new RegExp("^" + seconds + "\\s*[^0-9\\s]+$").test(el.textContent.trim()));
        if (group.length !== 1) throw new Error("Requested duration is not offered by this editor");
        return (group[0].querySelector(".toggle-text") ?? group[0]).textContent.trim();
      }, request.duration);
      await chooseRadio(duration, false);
    }
  }
  await page.press(settings, "Escape");
  await bindFrame(0, request.start);
  if (request.end) await bindFrame(1, request.end);

  await page.fill(editor, request.prompt);
  await page.waitForSelector(generate + ":enabled", { timeout: 12000 });
  const ready = await page.evaluate(({ editor, generate, end }) =>
    Boolean(document.querySelector(editor)?.textContent.trim() &&
      document.querySelectorAll(".frame-trigger .chip-container[aria-busy=false] img.chip-image")
        .length === (end ? 2 : 1) &&
      document.querySelector(generate)?.matches(":enabled")), { editor, generate, end: request.end });
  if (!ready) throw new Error("Flow did not confirm the frame inputs and prompt");

  // Watch only batches created by this submission, even in a populated project.
  const existing = await page.evaluate(grid => {
    if (document.querySelector("flow-video-tile flow-pending-tile")) {
      throw new Error("Wait for the active video job in this project before submitting another");
    }
    return [...document.querySelectorAll(grid + " flow-video-tile img.thumbnail")]
      .map(el => el.getAttribute("src"));
  }, grid);
  const findResult = ({ existing, prompt }) => {
    const thumbnails = [...document.querySelectorAll("flow-video-tile img.thumbnail")];
    const hits = thumbnails.filter(image => {
      const source = image.getAttribute("src");
      const batch = image.closest(".batch-container");
      return source && !existing.includes(source) &&
        !image.closest("flow-video-tile").querySelector("flow-pending-tile") &&
        (!batch || batch.textContent.replace(/\s+/g, " ").includes(prompt));
    });
    return hits.length === 1 ? thumbnails.indexOf(hits[0]) + 1 : null;
  };
  const resultQuery = { existing, prompt: request.prompt.replace(/\s+/g, " ").trim() };
  console.error("Requested frames and prompt verified. Submitting once.");
  submitted = true;
  await page.click(generate, { label: "Submit one Flow video" });
  await page.waitForFunction(findResult, resultQuery, { timeout: 540000 });
  const resultIndex = await page.evaluate(findResult, resultQuery);
  if (!Number.isInteger(resultIndex) || resultIndex < 1) {
    throw new Error("Flow video could not be identified");
  }
  await click("flow-video-tile img.thumbnail >> nth=" + (resultIndex - 1),
    "Open newly generated video");
  await page.waitForURL("**/edit/**", { timeout: 15000 });
  const clip = new URL(await page.url());
  const match = clip.pathname.match(/^\/project\/([a-z0-9-]+)\/edit\/([a-z0-9-]+)\/?$/i);
  if (clip.origin !== flow || match?.[1] !== project) throw new Error("Unexpected clip viewer URL");
  const id = match[2];
  console.error("Flow result identified: " + id);
  await page.waitForFunction(() => [...document.querySelectorAll("button mat-icon")]
    .some(el => el.textContent.trim() === "download" && el.getClientRects().length),
  undefined, { timeout: 15000 });
  const downloadButton = await page.evaluate(() =>
    [...document.querySelectorAll("button mat-icon")]
      .find(el => el.textContent.trim() === "download" && el.getClientRects().length)
      ?.closest("button")?.getAttribute("aria-label"));
  if (!downloadButton) throw new Error("Flow video download button is unavailable");
  await click("loc=role:button[name=" + JSON.stringify(downloadButton) + "]",
    "Open video download menu");
  const options = await page.evaluate(() => [...document.querySelectorAll("[role=menuitem]")]
    .map(el => el.getClientRects().length
      ? el.innerText.match(/^\s*(360p|720p|1080p)(?:\s|$)/)?.[1] : null));
  const index = options.indexOf(request.resolution ?? options.find(Boolean));
  if (index < 0) throw new Error("Flow did not offer an original MP4 download");
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 60000 }),
    page.click("[role=menuitem] >> nth=" + index,
      { label: "Download original Flow video" }),
  ]);
  await download.saveAs(request.output);
  console.log(JSON.stringify({ project, media_id: id }));
} catch (error) {
  console.error((submitted ? "Check the submitted Flow job before retrying. " : "") + error.message);
  throw new Error("Ego Lite video run failed");
}
