/*
 * File: upload.ts
 * Project: qwenproxy
 * File upload handler - forwards files to Qwen's OSS storage
 */

import type { Context } from "hono";
import { getQwenHeaders } from "../services/playwright.js";
import crypto from "crypto";

interface STSResponse {
  success: boolean;
  request_id: string;
  data: {
    access_key_id: string;
    access_key_secret: string;
    security_token: string;
    file_url: string;
    file_path: string;
    file_id: string;
    bucketname: string;
    region: string;
    endpoint: string;
  };
}

/**
 * Get STS token from Qwen for file upload
 * Retries once with refreshed headers if 401/RateLimited
 */
async function getSTSToken(
  filename: string,
  filesize: number,
  filetype: string,
  headers: Record<string, string>,
): Promise<STSResponse["data"]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(
      "https://chat.qwen.ai/api/v2/files/getstsToken",
      {
        method: "POST",
        headers: {
          Accept: "application/json, text/plain, */*",
          "Content-Type": "application/json",
          Cookie: headers.cookie,
          Origin: "https://chat.qwen.ai",
          Referer: "https://chat.qwen.ai/",
          "User-Agent": headers["user-agent"],
          "X-Request-Id": crypto.randomUUID(),
          "bx-ua": headers["bx-ua"],
          "bx-umidtoken": headers["bx-umidtoken"],
          "bx-v": headers["bx-v"],
        },
        body: JSON.stringify({ filename, filesize: String(filesize), filetype }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      // On 401, try refreshing headers once
      if (response.status === 401 && attempt === 0) {
        console.warn("[Upload] STS 401, refreshing headers and retrying...");
        const refreshed = await refreshUploadHeaders();
        if (refreshed) {
          Object.assign(headers, refreshed);
          continue;
        }
      }
      throw new Error(
        `STS token request failed: ${response.status} ${errorText.substring(0, 200)}`,
      );
    }

    const data = await response.json();
    if (!data.success || !data.data) {
      // Check if it's a 401/RateLimited error inside the response body
      const code = data.data?.code || data.code;
      const details = data.data?.details || data.message || "";
      if ((code === "RateLimited" && details.includes("401")) || details.includes("Unauthorized")) {
        if (attempt === 0) {
          console.warn("[Upload] STS returned 401 in body, refreshing headers and retrying...");
          const refreshed = await refreshUploadHeaders();
          if (refreshed) {
            Object.assign(headers, refreshed);
            continue;
          }
        }
      }
      throw new Error(
        `STS token invalid: ${JSON.stringify(data).substring(0, 200)}`,
      );
    }

    return data.data;
  }

  throw new Error("STS token request failed after retries");
}

/**
 * Refresh upload headers by forcing a new Qwen headers intercept
 */
async function refreshUploadHeaders(): Promise<Record<string, string> | null> {
  try {
    const { headers: qHeaders } = await getQwenHeaders(true);
    if (qHeaders['cookie'] && qHeaders['bx-ua']) {
      return {
        cookie: qHeaders['cookie'] || '',
        "user-agent": qHeaders['user-agent'] || '',
        "bx-ua": qHeaders['bx-ua'] || '',
        "bx-umidtoken": qHeaders['bx-umidtoken'] || '',
        "bx-v": qHeaders['bx-v'] || '',
      };
    }
  } catch (err: any) {
    console.error("[Upload] Failed to refresh headers:", err.message);
  }
  return null;
}

/**
 * Upload file to Alibaba Cloud OSS using STS credentials
 */
// Cache the heavy ali-oss module so we import it once, not on every upload.
let cachedOSSModule: typeof import("ali-oss").default | null = null;
async function getOSSModule() {
  if (!cachedOSSModule) {
    cachedOSSModule = (await import("ali-oss")).default;
  }
  return cachedOSSModule;
}

async function uploadToOSS(
  fileBuffer: ArrayBuffer,
  stsData: STSResponse["data"],
  filename: string,
): Promise<string> {
  const {
    access_key_id,
    access_key_secret,
    security_token,
    file_url,
    file_path,
    bucketname,
    region,
    endpoint,
  } = stsData;

  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    return stsData.file_url.split("?")[0];
  }

  const OSS = await getOSSModule();
  const client = new OSS({
    region,
    accessKeyId: access_key_id,
    accessKeySecret: access_key_secret,
    stsToken: security_token,
    bucket: bucketname,
    endpoint: `https://${endpoint}`,
    secure: true,
    refreshSTSToken: async () => ({
      accessKeyId: access_key_id,
      accessKeySecret: access_key_secret,
      stsToken: security_token,
    }),
    refreshSTSTokenInterval: 300000,
  });

  const buffer = Buffer.from(fileBuffer);
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const mimeMap: Record<string, string> = {
    // Images
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    // Video
    mp4: "video/mp4",
    mov: "video/quicktime",
    avi: "video/x-msvideo",
    webm: "video/webm",
    mkv: "video/x-matroska",
    // Audio
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    flac: "audio/flac",
    m4a: "audio/mp4",
    aac: "audio/aac",
    // Documents
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    json: "application/json",
    xml: "application/xml",
    html: "text/html",
    zip: "application/zip",
  };
  const contentType = mimeMap[ext] || "application/octet-stream";

  await client.put(file_path, buffer, {
    headers: { "Content-Type": contentType },
  });

  return file_url.split("?")[0];
}

/**
 * Handle image upload endpoint
 * POST /v1/upload
 */
export async function uploadFile(c: Context) {
  try {
    const formData = await c.req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return c.json({ error: "No file provided" }, 400);
    }

    // Detect MIME from filename if browser sends generic type
    let fileType = file.type;
    if (fileType === "application/octet-stream" || !fileType) {
      const ext = file.name.split(".").pop()?.toLowerCase() || "";
      const extMimeMap: Record<string, string> = {
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        gif: "image/gif",
        webp: "image/webp",
        mp4: "video/mp4",
        mov: "video/quicktime",
        avi: "video/x-msvideo",
        webm: "video/webm",
        mkv: "video/x-matroska",
        mp3: "audio/mpeg",
        wav: "audio/wav",
        ogg: "audio/ogg",
        flac: "audio/flac",
        m4a: "audio/mp4",
        aac: "audio/aac",
        pdf: "application/pdf",
        doc: "application/msword",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        xls: "application/vnd.ms-excel",
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ppt: "application/vnd.ms-powerpoint",
        pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        txt: "text/plain",
        md: "text/markdown",
        csv: "text/csv",
        json: "application/json",
        xml: "application/xml",
        html: "text/html",
        zip: "application/zip",
      };
      fileType = extMimeMap[ext] || "application/octet-stream";
    }

    // Determine media category for size limits
    const isVideo = fileType.startsWith("video/");
    const isAudio = fileType.startsWith("audio/");
    const isImage = fileType.startsWith("image/");
    let maxSize = 20 * 1024 * 1024; // 20MB default for docs/images
    if (isVideo)
      maxSize = 100 * 1024 * 1024; // 100MB for video
    else if (isAudio) maxSize = 50 * 1024 * 1024; // 50MB for audio
    if (file.size > maxSize) {
      const sizeLabel = isVideo
        ? "100MB (video)"
        : isAudio
          ? "50MB (audio)"
          : "20MB (image/doc)";
      return c.json({ error: `File too large. Max size: ${sizeLabel}` }, 400);
    }

    // Get full Qwen headers with bx-ua/bx-umidtoken
    let headers: Record<string, string> | null = null;
    try {
      const { headers: qHeaders } = await getQwenHeaders(false);
      if (qHeaders['cookie'] && qHeaders['bx-ua']) {
        headers = {
          cookie: qHeaders['cookie'] || '',
          "user-agent": qHeaders['user-agent'] || '',
          "bx-ua": qHeaders['bx-ua'] || '',
          "bx-umidtoken": qHeaders['bx-umidtoken'] || '',
          "bx-v": qHeaders['bx-v'] || '',
        };
      }
    } catch (err: any) {
      console.error("[Upload] Failed to get Qwen headers:", err.message);
    }

    if (!headers) {
      return c.json(
        { error: "Authentication not ready. Send a chat message first." },
        503,
      );
    }

    // Determine Qwen filetype for STS token
    let qwenFileType = "file";
    if (isVideo) qwenFileType = "video";
    else if (isAudio) qwenFileType = "audio";
    else if (isImage) qwenFileType = "image";

    const stsData = await getSTSToken(
      file.name,
      file.size,
      qwenFileType,
      headers,
    );
    const fileBuffer = await file.arrayBuffer();
    const fileUrl = await uploadToOSS(fileBuffer, stsData, file.name);

    return c.json({
      url: fileUrl,
      file_id: stsData.file_id,
      filename: file.name,
      type: qwenFileType,
    });
  } catch (error: any) {
    console.error("[Upload] Error:", error.message);
    return c.json({ error: error.message }, 500);
  }
}

/**
 * Qwen file format for images
 */
export interface QwenFileEntry {
  type: string;
  file: {
    created_at: number;
    data: Record<string, unknown>;
    filename: string;
    hash: string | null;
    id: string;
    user_id: string;
    meta: { name: string; size: number; content_type: string };
    update_at: number;
    lastModified: number;
    name: string;
    webkitRelativePath: string;
    size: number;
    type: string;
  };
  id: string;
  url: string;
  name: string;
  collection_name: string;
  progress: number;
  status: string;
  greenNet: string;
  size: number;
  error: string;
  itemId: string;
  file_type: string;
  showType: string;
  file_class: string;
  uploadTaskId: string;
}

/**
 * Detect file type from URL or filename
 */
function detectFileType(filename: string): {
  mime: string;
  showType: string;
  fileClass: string;
  qwenFileType: string;
} {
  const ext = filename.split(".").pop()?.toLowerCase() || "";

  const typeMap: Record<
    string,
    { mime: string; showType: string; fileClass: string; qwenFileType: string }
  > = {
    // Images
    png: {
      mime: "image/png",
      showType: "image",
      fileClass: "vision",
      qwenFileType: "image",
    },
    jpg: {
      mime: "image/jpeg",
      showType: "image",
      fileClass: "vision",
      qwenFileType: "image",
    },
    jpeg: {
      mime: "image/jpeg",
      showType: "image",
      fileClass: "vision",
      qwenFileType: "image",
    },
    gif: {
      mime: "image/gif",
      showType: "image",
      fileClass: "vision",
      qwenFileType: "image",
    },
    webp: {
      mime: "image/webp",
      showType: "image",
      fileClass: "vision",
      qwenFileType: "image",
    },
    // Video
    mp4: {
      mime: "video/mp4",
      showType: "video",
      fileClass: "video",
      qwenFileType: "video",
    },
    mov: {
      mime: "video/quicktime",
      showType: "video",
      fileClass: "video",
      qwenFileType: "video",
    },
    avi: {
      mime: "video/x-msvideo",
      showType: "video",
      fileClass: "video",
      qwenFileType: "video",
    },
    webm: {
      mime: "video/webm",
      showType: "video",
      fileClass: "video",
      qwenFileType: "video",
    },
    mkv: {
      mime: "video/x-matroska",
      showType: "video",
      fileClass: "video",
      qwenFileType: "video",
    },
    // Audio
    mp3: {
      mime: "audio/mpeg",
      showType: "audio",
      fileClass: "audio",
      qwenFileType: "audio",
    },
    wav: {
      mime: "audio/wav",
      showType: "audio",
      fileClass: "audio",
      qwenFileType: "audio",
    },
    ogg: {
      mime: "audio/ogg",
      showType: "audio",
      fileClass: "audio",
      qwenFileType: "audio",
    },
    flac: {
      mime: "audio/flac",
      showType: "audio",
      fileClass: "audio",
      qwenFileType: "audio",
    },
    m4a: {
      mime: "audio/mp4",
      showType: "audio",
      fileClass: "audio",
      qwenFileType: "audio",
    },
    aac: {
      mime: "audio/aac",
      showType: "audio",
      fileClass: "audio",
      qwenFileType: "audio",
    },
    // Documents
    pdf: {
      mime: "application/pdf",
      showType: "file",
      fileClass: "file",
      qwenFileType: "file",
    },
    doc: {
      mime: "application/msword",
      showType: "file",
      fileClass: "file",
      qwenFileType: "file",
    },
    docx: {
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      showType: "file",
      fileClass: "file",
      qwenFileType: "file",
    },
    xls: {
      mime: "application/vnd.ms-excel",
      showType: "file",
      fileClass: "file",
      qwenFileType: "file",
    },
    xlsx: {
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      showType: "file",
      fileClass: "file",
      qwenFileType: "file",
    },
    ppt: {
      mime: "application/vnd.ms-powerpoint",
      showType: "file",
      fileClass: "file",
      qwenFileType: "file",
    },
    pptx: {
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      showType: "file",
      fileClass: "file",
      qwenFileType: "file",
    },
    txt: {
      mime: "text/plain",
      showType: "file",
      fileClass: "file",
      qwenFileType: "file",
    },
    md: {
      mime: "text/markdown",
      showType: "file",
      fileClass: "file",
      qwenFileType: "file",
    },
    csv: {
      mime: "text/csv",
      showType: "file",
      fileClass: "file",
      qwenFileType: "file",
    },
    json: {
      mime: "application/json",
      showType: "file",
      fileClass: "file",
      qwenFileType: "file",
    },
    xml: {
      mime: "application/xml",
      showType: "file",
      fileClass: "file",
      qwenFileType: "file",
    },
    html: {
      mime: "text/html",
      showType: "file",
      fileClass: "file",
      qwenFileType: "file",
    },
    zip: {
      mime: "application/zip",
      showType: "file",
      fileClass: "file",
      qwenFileType: "file",
    },
  };

  return (
    typeMap[ext] || {
      mime: "application/octet-stream",
      showType: "file",
      fileClass: "file",
      qwenFileType: "file",
    }
  );
}

/**
 * Process OpenAI-style image/video content into Qwen file format
 */
export async function processImagesForQwen(
  content: Array<{
    type: string;
    text?: string;
    image_url?: { url: string };
    video_url?: { url: string };
    audio_url?: { url: string };
    file_url?: { url: string };
  }>,
  headers: Record<string, string>,
): Promise<{ text: string; files: QwenFileEntry[] }> {
  const textParts: string[] = [];
  const files: QwenFileEntry[] = [];

  for (const part of content) {
    if (part.type === "text" && part.text) {
      textParts.push(part.text);
    } else if (
      (part.type === "image_url" && part.image_url?.url) ||
      (part.type === "video_url" && part.video_url?.url) ||
      (part.type === "audio_url" && part.audio_url?.url) ||
      (part.type === "file_url" && part.file_url?.url)
    ) {
      const mediaUrl =
        part.type === "video_url"
          ? part.video_url!.url
          : part.type === "audio_url"
            ? part.audio_url!.url
            : part.type === "file_url"
              ? part.file_url!.url
              : part.image_url!.url;
      let fileUrl = "";
      let filename = "";
      let fileSize = 0;
      let fileId = "";

      if (mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://")) {
        try {
          const downloadRes = await fetch(mediaUrl);
          if (!downloadRes.ok) {
            console.error(`[Upload] Failed to download media: ${downloadRes.status} ${mediaUrl}`);
            continue;
          }
          const buffer = Buffer.from(await downloadRes.arrayBuffer());
          fileSize = buffer.length;
          filename = mediaUrl.split("/").pop()?.split("?")[0] || "file.bin";
          if (!filename.includes(".")) {
            const mime = downloadRes.headers.get("content-type") || "";
            const mimeExt: Record<string, string> = {
              "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
              "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm",
              "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg",
              "audio/flac": "flac", "audio/mp4": "m4a", "audio/aac": "aac",
              "application/pdf": "pdf",
            };
            const ext = mimeExt[mime] || "bin";
            filename = `${filename}.${ext}`;
          }
          const typeInfo = detectFileType(filename);
          const stsData = await getSTSToken(
            filename,
            fileSize,
            typeInfo.qwenFileType,
            headers,
          );
          fileUrl = await uploadToOSS(buffer.buffer, stsData, filename);
          fileId = stsData.file_id;
        } catch (err: any) {
          console.error("[Upload] Failed to download/re-upload HTTP media:", err.message);
          continue;
        }
      } else if (mediaUrl.startsWith("data:")) {
        try {
          // Detect type from data URI
          const dataMime = mediaUrl.match(/^data:([^;]+)/)?.[1] || "";
          const isVideoData = dataMime.startsWith("video/");
          const isAudioData = dataMime.startsWith("audio/");
          const extFromMime: Record<string, string> = {
            "video/mp4": "mp4",
            "video/webm": "webm",
            "video/quicktime": "mov",
            "audio/mpeg": "mp3",
            "audio/wav": "wav",
            "audio/ogg": "ogg",
            "audio/flac": "flac",
            "audio/mp4": "m4a",
            "audio/aac": "aac",
            "image/png": "png",
            "image/jpeg": "jpg",
            "image/gif": "gif",
            "image/webp": "webp",
            "application/pdf": "pdf",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
          };
          const detectedExt =
            extFromMime[dataMime] ||
            (isVideoData ? "mp4" : isAudioData ? "mp3" : "png");
          const base64Data = mediaUrl.split(",")[1];
          const buffer = Buffer.from(base64Data, "base64");
          filename = `${isVideoData ? "video" : isAudioData ? "audio" : "file"}_${Date.now()}.${detectedExt}`;
          fileSize = buffer.length;
          const typeInfo = detectFileType(filename);
          const stsData = await getSTSToken(
            filename,
            fileSize,
            typeInfo.qwenFileType,
            headers,
          );
          fileUrl = await uploadToOSS(buffer.buffer, stsData, filename);
          fileId = stsData.file_id;
        } catch (err: any) {
          console.error("[Upload] Failed to upload media:", err.message);
          continue;
        }
      }

      if (fileUrl) {
        const typeInfo = detectFileType(filename);
        files.push({
          type: typeInfo.showType,
          file: {
            created_at: Date.now(),
            data: {},
            filename,
            hash: null,
            id: fileId,
            user_id: "proxy-user",
            meta: {
              name: filename,
              size: fileSize,
              content_type: typeInfo.mime,
            },
            update_at: Date.now(),
            lastModified: Date.now(),
            name: filename,
            webkitRelativePath: "",
            size: fileSize,
            type: typeInfo.mime,
          },
          id: fileId,
          url: fileUrl,
          name: filename,
          collection_name: "",
          progress: 100,
          status: "uploaded",
          greenNet: "success",
          size: fileSize,
          error: "",
          itemId: crypto.randomUUID(),
          file_type: typeInfo.mime,
          showType: typeInfo.showType,
          file_class: typeInfo.fileClass,
          uploadTaskId: crypto.randomUUID(),
        });
      }
    }
  }

  return { text: textParts.join("\n"), files };
}

const LARGE_PROMPT_THRESHOLD = 131072;

export async function uploadLargePromptAsFile(
  promptText: string,
  headers: Record<string, string>,
): Promise<QwenFileEntry | null> {
  const byteLength = Buffer.byteLength(promptText, "utf-8");
  if (byteLength <= LARGE_PROMPT_THRESHOLD) return null;

  const filename = `prompt_${Date.now()}.txt`;
  const buffer = Buffer.from(promptText, "utf-8");

  const stsData = await getSTSToken(filename, buffer.length, "file", headers);
  const fileUrl = await uploadToOSS(buffer.buffer, stsData, filename);

  return {
    type: "file",
    file: {
      created_at: Date.now(),
      data: {},
      filename,
      hash: null,
      id: stsData.file_id,
      user_id: "proxy-user",
      meta: { name: filename, size: buffer.length, content_type: "text/plain" },
      update_at: Date.now(),
      lastModified: Date.now(),
      name: filename,
      webkitRelativePath: "",
      size: buffer.length,
      type: "text/plain",
    },
    id: stsData.file_id,
    url: fileUrl,
    name: filename,
    collection_name: "",
    progress: 100,
    status: "uploaded",
    greenNet: "success",
    size: buffer.length,
    error: "",
    itemId: crypto.randomUUID(),
    file_type: "text/plain",
    showType: "file",
    file_class: "file",
    uploadTaskId: crypto.randomUUID(),
  };
}
