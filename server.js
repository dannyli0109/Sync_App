const path = require('path');
require('dotenv').config({
  path: path.resolve(__dirname, '.env'),
});
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const OSS = require('ali-oss');
const { nanoid } = require('nanoid');
const OpenApi = require('@alicloud/openapi-client');
const Util = require('@alicloud/tea-util');
const Mts = require('@alicloud/mts20140618');

const app = express();
const server = createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MAX_UPLOAD_SIZE_BYTES = Number(
  process.env.MAX_UPLOAD_SIZE_BYTES || 1024 * 1024 * 1024 * 10,
);
const MIN_PART_SIZE_BYTES = 5 * 1024 * 1024;
const DEFAULT_PART_SIZE_BYTES = Math.max(
  Number(process.env.OSS_MULTIPART_PART_SIZE) || 10 * 1024 * 1024,
  MIN_PART_SIZE_BYTES,
);
const MAX_PART_COUNT = 10000;
const PART_UPLOAD_EXPIRY_SECONDS = Math.max(
  Number(process.env.OSS_PART_UPLOAD_EXPIRES) || 900,
  60,
);
const OSS_UPLOAD_EXPIRY_SECONDS = Math.max(
  Number(process.env.OSS_UPLOAD_EXPIRY_SECONDS) || 120,
  30,
);
const OSS_PLAYBACK_EXPIRY_SECONDS = Math.max(
  Number(process.env.OSS_PLAYBACK_EXPIRY_SECONDS) || 3600,
  60,
);

const OSS_VIDEO_PREFIX = ensureTrailingSlash(
  process.env.OSS_VIDEO_PREFIX || 'videos/',
);

const ossConfig = {
  accessKeyId: process.env.OSS_ACCESS_KEY_ID,
  accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
  bucket: process.env.OSS_BUCKET,
  region: process.env.OSS_REGION,
  endpoint: process.env.OSS_ENDPOINT,
  secure: process.env.OSS_SECURE === 'false' ? false : true,
};

const DEFAULT_REGION =
  ossConfig.region || extractRegionFromEndpoint(ossConfig.endpoint);

const mpsConfig = {
  regionId: process.env.MPS_REGION_ID || DEFAULT_REGION,
  pipelineId: process.env.MPS_PIPELINE_ID,
  templateId: process.env.MPS_TEMPLATE_ID,
  outputBucket: process.env.MPS_OUTPUT_BUCKET || ossConfig.bucket,
  outputLocation:
    process.env.MPS_OUTPUT_LOCATION ||
    process.env.MPS_REGION_ID ||
    DEFAULT_REGION,
  outputPrefix: ensureTrailingSlash(process.env.MPS_OUTPUT_PREFIX || 'processed/'),
  notifyTopic: process.env.MPS_NOTIFY_TOPIC,
  notifyQueue: process.env.MPS_NOTIFY_QUEUE,
};

let ossClient = null;
let mtsClient = null;

const rooms = new Map();
const videos = new Map();

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function ensureRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = {
      hostId: null,
      participants: new Set(),
      state: null,
    };
    rooms.set(roomId, room);
  }
  return room;
}

function getRoomForSocket(socket) {
  const { roomId } = socket.data;
  if (!roomId) return null;
  return rooms.get(roomId) || null;
}

function setHost(room, newHostId) {
  room.hostId = newHostId;
}

function ensureTrailingSlash(value) {
  if (!value) return '';
  const trimmed = value.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
  return trimmed ? `${trimmed}/` : '';
}

function extractRegionFromEndpoint(endpoint) {
  if (!endpoint) return null;
  const match = endpoint.match(/oss-([a-z0-9-]+)\./i);
  return match ? `oss-${match[1]}` : null;
}

function isOssConfigured() {
  return Boolean(
    ossConfig.accessKeyId &&
    ossConfig.accessKeySecret &&
    ossConfig.bucket &&
    (ossConfig.region || ossConfig.endpoint),
  );
}

function getOssClient() {
  if (!isOssConfigured()) {
    return null;
  }
  if (!ossClient) {
    const baseConfig = {
      accessKeyId: ossConfig.accessKeyId,
      accessKeySecret: ossConfig.accessKeySecret,
      bucket: ossConfig.bucket,
      secure: ossConfig.secure,
    };
    if (ossConfig.endpoint) {
      baseConfig.endpoint = ossConfig.endpoint;
    } else if (ossConfig.region) {
      baseConfig.region = ossConfig.region;
    }
    ossClient = new OSS(baseConfig);
  }
  return ossClient;
}

function isMpsConfigured() {
  return Boolean(
    ossConfig.accessKeyId &&
    ossConfig.accessKeySecret &&
    mpsConfig.regionId &&
    mpsConfig.pipelineId &&
    mpsConfig.templateId &&
    mpsConfig.outputBucket &&
    mpsConfig.outputLocation,
  );
}

function getMtsClient() {
  if (!isMpsConfigured()) {
    return null;
  }
  if (!mtsClient) {
    const config = new OpenApi.Config({
      accessKeyId: ossConfig.accessKeyId,
      accessKeySecret: ossConfig.accessKeySecret,
      regionId: mpsConfig.regionId,
      endpoint: `mts.${mpsConfig.regionId}.aliyuncs.com`,
    });
    mtsClient = new Mts.default(config);
  }
  return mtsClient;
}

function respondOssNotConfigured(res) {
  res.status(503).json({
    error: 'OssNotConfigured',
    message:
      'Aliyun OSS credentials are missing. Set OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET, OSS_BUCKET, and OSS_REGION or OSS_ENDPOINT.',
  });
}

function sanitizeFilename(name) {
  if (!name || typeof name !== 'string') {
    return 'video';
  }
  return name
    .replace(/[\u0000-\u001f<>:"/\\|?*%]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-180) || 'video';
}

function cleanDisplayName(name, fallback) {
  if (typeof name === 'string') {
    const trimmed = name.trim();
    if (trimmed) {
      return trimmed.slice(0, 180);
    }
  }
  return fallback;
}

function isValidHttpUrl(value) {
  if (!value || typeof value !== 'string') {
    return false;
  }
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function inferDisplayNameFromUrl(value) {
  if (!value) return 'Shared video';
  try {
    const parsed = new URL(value);
    const segments = parsed.pathname.split('/').filter(Boolean);
    let candidate = segments.pop() || parsed.hostname || value;
    candidate = candidate.replace(/[?#].*$/, '');
    try {
      candidate = decodeURIComponent(candidate);
    } catch {
      // ignore decode issues
    }
    const cleaned = cleanDisplayName(candidate, parsed.hostname || 'Shared video');
    return cleaned || 'Shared video';
  } catch {
    return 'Shared video';
  }
}

function buildObjectKey(videoId, originalName) {
  const cleaned = sanitizeFilename(originalName);
  return `${OSS_VIDEO_PREFIX}${videoId}/${cleaned}`;
}

function determinePartSize(totalSize) {
  let partSize = Number(DEFAULT_PART_SIZE_BYTES) || MIN_PART_SIZE_BYTES;
  if (!Number.isFinite(partSize) || partSize < MIN_PART_SIZE_BYTES) {
    partSize = MIN_PART_SIZE_BYTES;
  }
  const maxPartSize = 1024 * 1024 * 1024; // 1GB
  if (Number.isFinite(totalSize) && totalSize > 0) {
    while (Math.ceil(totalSize / partSize) > MAX_PART_COUNT && partSize < maxPartSize) {
      partSize *= 2;
    }
  }
  return Math.min(partSize, maxPartSize);
}

function buildTranscodeObjectKey(record) {
  if (!record) return null;
  const parsed = path.parse(record.originalName || record.id);
  const baseName = sanitizeFilename(parsed.name || record.id);
  return `${mpsConfig.outputPrefix}${record.id}/${baseName || record.id}.mp4`;
}

function normalizeEtag(etag) {
  if (!etag) return null;
  return etag.replace(/^"+|"+$/g, '');
}

async function createPlaybackUrl(objectKey) {
  const client = getOssClient();
  if (!client) {
    throw new Error('OSS client not configured');
  }
  const expiresAt = Date.now() + OSS_PLAYBACK_EXPIRY_SECONDS * 1000;
  const url = client.signatureUrl(objectKey, {
    method: 'GET',
    expires: OSS_PLAYBACK_EXPIRY_SECONDS,
  });
  return { url, expiresAt };
}

async function resolvePlaybackForRecord(record) {
  if (!record) {
    throw new Error('Video record is required for playback');
  }
  if (record.type === 'external') {
    if (!record.externalUrl) {
      throw new Error('External video URL is missing');
    }
    return { url: record.externalUrl, expiresAt: null };
  }
  const ossKey = record.playbackKey || record.objectKey;
  if (!ossKey) {
    throw new Error('Playback key is missing for this video');
  }
  return createPlaybackUrl(ossKey);
}

async function ensurePlaybackUrl(state) {
  if (!state || !state.ossKey) {
    return state;
  }
  const now = Date.now();
  const bufferMs = 60 * 1000;
  if (!state.playbackExpiresAt || now >= state.playbackExpiresAt - bufferMs) {
    try {
      const playback = await createPlaybackUrl(state.ossKey);
      state.videoUrl = playback.url;
      state.playbackExpiresAt = playback.expiresAt;
    } catch (error) {
      console.error('Failed to refresh playback URL', error);
    }
  }
  return state;
}

function presentState(state) {
  if (!state) return null;
  const {
    ossKey: _ossKey,
    playbackExpiresAt: _playbackExpiresAt,
    ...publicState
  } = state;
  return publicState;
}

async function prepareStateForClient(state) {
  if (!state) return null;
  await ensurePlaybackUrl(state);
  return presentState(state);
}

async function ensureTranscodeAssignment(record) {
  if (!record) return null;
  if (record.type === 'external') {
    record.playbackKey = null;
    if (!record.status || record.status === 'uploading') {
      record.status = 'ready';
    }
    return record;
  }
  if (!isMpsConfigured() || !record.transcodeTargetKey) {
    record.playbackKey = record.objectKey;
    if (record.status !== 'error') {
      record.status = 'ready';
    }
    return record;
  }

  const client = getOssClient();
  try {
    await client.head(record.transcodeTargetKey);
    record.playbackKey = record.transcodeTargetKey;
    record.status = 'ready';
    if (record.transcodeJob) {
      record.transcodeJob.state = 'Finished';
      record.transcodeJob.completedAt = Date.now();
    }
  } catch (error) {
    if (error && (error.code === 'NoSuchKey' || error.status === 404)) {
      record.playbackKey = record.objectKey;
      if (record.status !== 'ready') {
        record.status = 'processing';
      }
    } else {
      console.error('Failed to check transcode output', error);
      record.playbackKey = record.objectKey;
      if (record.status !== 'ready') {
        record.status = 'processing';
      }
    }
  }
  return record;
}

async function resolveVideoRecord(videoId) {
  if (!videoId) {
    return null;
  }

  let record = videos.get(videoId);
  if (record && record.type === 'external') {
    return record;
  }

  const client = getOssClient();
  if (!client) {
    return record || null;
  }

  try {
    if (!record) {
      const prefix = `${OSS_VIDEO_PREFIX}${videoId}/`;
      const listResponse = await client.list({
        prefix,
        'max-keys': 1,
      });
      const [object] = listResponse.objects || [];
      if (!object || !object.name) {
        return null;
      }
      const parsedName = object.name.slice(prefix.length);
      let originalName = parsedName || sanitizeFilename('video');
      try {
        if (parsedName) {
          originalName = decodeURIComponent(parsedName);
        }
      } catch {
        originalName = parsedName || sanitizeFilename('video');
      }
      record = {
        id: videoId,
        objectKey: object.name,
        originalName,
        mimeType: 'application/octet-stream',
        size: Number(object.size) || 0,
        createdAt: Date.now(),
        status: 'ready',
      };
      if (isMpsConfigured()) {
        record.transcodeTargetKey = buildTranscodeObjectKey(record);
      }
      videos.set(videoId, record);
    }

    const headResponse = await client.head(record.objectKey);
    const headers = (headResponse && headResponse.res && headResponse.res.headers) || {};
    record.mimeType =
      headers['content-type'] || record.mimeType || 'application/octet-stream';
    record.size = Number(headers['content-length'] || record.size || 0);
    record.lastModified = new Date(
      headers['last-modified'] || record.lastModified || Date.now(),
    ).getTime();
    record.etag = normalizeEtag(headers.etag || record.etag);
    record.status = record.status || 'ready';

    if (!record.playbackKey) {
      record.playbackKey = record.objectKey;
    }

    if (isMpsConfigured()) {
      if (!record.transcodeTargetKey) {
        record.transcodeTargetKey = buildTranscodeObjectKey(record);
      }
      await ensureTranscodeAssignment(record);
    } else {
      record.playbackKey = record.objectKey;
      record.status = 'ready';
    }

    videos.set(videoId, record);
    return record;
  } catch (error) {
    if (error && error.code === 'NoSuchKey') {
      return null;
    }
    console.error(`Failed to resolve video ${videoId} from OSS`, error);
    return null;
  }
}

async function collectUploadedParts(record) {
  const client = getOssClient();
  const parts = [];
  let partNumberMarker = null;

  do {
    const response = await client.listParts(record.objectKey, record.uploadId, {
      'max-parts': 1000,
      partNumberMarker,
    });
    const list = response.parts || [];
    for (const part of list) {
      const number = Number(part.partNumber || part.PartNumber);
      const etag = normalizeEtag(part.etag || part.ETag);
      if (Number.isInteger(number) && etag) {
        parts.push({ number, etag });
      }
    }
    partNumberMarker = response.nextPartNumberMarker;
    if (!response.isTruncated) {
      break;
    }
  } while (true);

  return parts.sort((a, b) => a.number - b.number);
}

async function maybeSubmitTranscodeJob(record) {
  if (!isMpsConfigured() || !record) {
    return null;
  }

  try {
    const client = getMtsClient();
    if (!client) {
      return null;
    }

    if (!record.transcodeTargetKey) {
      record.transcodeTargetKey = buildTranscodeObjectKey(record);
    }

    const input = {
      Bucket: ossConfig.bucket,
      Location: mpsConfig.outputLocation,
      Object: encodeURIComponent(record.objectKey),
    };

    const outputs = [
      {
        OutputObject: encodeURIComponent(record.transcodeTargetKey),
        TemplateId: mpsConfig.templateId,
      },
    ];

    const request = new Mts.SubmitJobsRequest({
      Input: JSON.stringify(input),
      Outputs: JSON.stringify(outputs),
      OutputBucket: mpsConfig.outputBucket,
      OutputLocation: mpsConfig.outputLocation,
      PipelineId: mpsConfig.pipelineId,
    });

    if (mpsConfig.notifyTopic || mpsConfig.notifyQueue) {
      request.NotifyConfig = JSON.stringify({
        Topic: mpsConfig.notifyTopic || '',
        QueueName: mpsConfig.notifyQueue || '',
      });
    }

    const runtime = new Util.RuntimeOptions({});
    const response =
      typeof client.submitJobsWithOptions === 'function'
        ? await client.submitJobsWithOptions(request, runtime)
        : await client.submitJobs(request);
    const jobResults = response?.body?.JobResultList?.JobResult || [];
    const job = jobResults[0]?.Job;
    if (job && job.JobId) {
      record.transcodeJob = {
        jobId: job.JobId,
        state: job.State || 'Submitted',
        submittedAt: Date.now(),
        outputObject: record.transcodeTargetKey,
      };
      record.status = 'processing';
      return record.transcodeJob;
    }
    return null;
  } catch (error) {
    console.error('Failed to submit transcode job', error);
    record.transcodeJob = {
      state: 'error',
      errorMessage: error.message,
      failedAt: Date.now(),
    };
    record.status = 'ready';
    return null;
  }
}

async function queryTranscodeJob(record) {
  if (!isMpsConfigured() || !record?.transcodeJob?.jobId) {
    return null;
  }
  try {
    const client = getMtsClient();
    if (!client) return null;
    const request = new Mts.QueryJobListRequest({
      JobIds: record.transcodeJob.jobId,
    });
    const runtime = new Util.RuntimeOptions({});
    const response =
      typeof client.queryJobListWithOptions === 'function'
        ? await client.queryJobListWithOptions(request, runtime)
        : await client.queryJobList(request);
    const jobs = response?.body?.JobList?.Job || [];
    const job = jobs[0];
    if (job) {
      record.transcodeJob.state = job.State || record.transcodeJob.state;
      record.transcodeJob.lastUpdatedAt = Date.now();
      if (job.State === 'Finished' || job.State === 'Success') {
        await ensureTranscodeAssignment(record);
      } else if (job.State === 'Fail' || job.State === 'Canceled') {
        record.status = 'error';
      }
    }
    return record.transcodeJob;
  } catch (error) {
    console.error('Failed to query transcode job', error);
    return null;
  }
}

app.post('/api/videos/multipart/init', async (req, res) => {
  if (!isOssConfigured()) {
    return respondOssNotConfigured(res);
  }

  const { filename, sizeBytes, mimeType } = req.body || {};
  const totalSize = Number(sizeBytes) || 0;

  if (totalSize && totalSize > MAX_UPLOAD_SIZE_BYTES) {
    return res.status(413).json({
      error: 'UploadTooLarge',
      message: 'The video exceeds the configured upload size limit.',
    });
  }

  const safeName = sanitizeFilename(filename || 'video');
  const type =
    typeof mimeType === 'string' && mimeType ? mimeType : 'application/octet-stream';

  try {
    const client = getOssClient();
    const videoId = nanoid(12);
    const objectKey = buildObjectKey(videoId, safeName);
    const partSize = determinePartSize(totalSize);

    const initOptions = type ? { headers: { 'Content-Type': type } } : undefined;
    const initResponse = await client.initMultipartUpload(objectKey, initOptions);
    const uploadId = initResponse.uploadId;

    const record = {
      id: videoId,
      objectKey,
      uploadId,
      originalName: safeName,
      mimeType: type,
      size: totalSize,
      createdAt: Date.now(),
      partSize,
      status: 'uploading',
    };

    if (isMpsConfigured()) {
      record.transcodeTargetKey = buildTranscodeObjectKey(record);
    }

    videos.set(videoId, record);

    res.json({
      videoId,
      uploadId,
      objectKey,
      partSizeBytes: partSize,
      maxPartCount: MAX_PART_COUNT,
      mimeType: record.mimeType,
      expiresAt: new Date(Date.now() + PART_UPLOAD_EXPIRY_SECONDS * 1000).toISOString(),
    });
  } catch (error) {
    console.error('Failed to initialise multipart upload', error);
    res.status(500).json({
      error: 'InitMultipartFailed',
      message: 'Failed to initialise multipart upload.',
    });
  }
});

app.post('/api/videos/multipart/part-url', (req, res) => {
  if (!isOssConfigured()) {
    return respondOssNotConfigured(res);
  }

  const { videoId, partNumber } = req.body || {};
  const partNo = Number(partNumber);

  if (!videoId || !Number.isInteger(partNo) || partNo < 1 || partNo > MAX_PART_COUNT) {
    return res.status(400).json({
      error: 'InvalidPartRequest',
      message: 'Provide a valid videoId and partNumber between 1 and 10000.',
    });
  }

  const record = videos.get(videoId);
  if (!record || record.status !== 'uploading' || !record.uploadId) {
    return res.status(404).json({
      error: 'UploadNotFound',
      message: 'Upload session not found or already completed.',
    });
  }

  try {
    const client = getOssClient();
    const uploadUrl = client.signatureUrl(record.objectKey, {
      method: 'PUT',
      expires: PART_UPLOAD_EXPIRY_SECONDS,
      partNumber: partNo,
      uploadId: record.uploadId,
      ...(record.mimeType ? { 'Content-Type': record.mimeType } : {}),
    });

    res.json({
      uploadUrl,
      expiresAt: new Date(Date.now() + PART_UPLOAD_EXPIRY_SECONDS * 1000).toISOString(),
    });
  } catch (error) {
    console.error('Failed to generate part upload URL', error);
    res.status(500).json({
      error: 'PartUrlFailed',
      message: 'Failed to generate part upload URL.',
    });
  }
});

app.post('/api/videos/multipart/complete', async (req, res) => {
  if (!isOssConfigured()) {
    return respondOssNotConfigured(res);
  }

  const { videoId } = req.body || {};
  if (!videoId || typeof videoId !== 'string') {
    return res.status(400).json({
      error: 'InvalidVideoId',
      message: 'Video ID is required.',
    });
  }

  const record = videos.get(videoId);
  if (!record || record.status !== 'uploading' || !record.uploadId) {
    return res.status(404).json({
      error: 'UploadNotFound',
      message: 'Upload session not found or already completed.',
    });
  }

  try {
    const client = getOssClient();
    const parts = await collectUploadedParts(record);
    if (!parts.length) {
      return res.status(400).json({
        error: 'NoPartsUploaded',
        message: 'No uploaded parts were found for this upload session.',
      });
    }

    await client.completeMultipartUpload(record.objectKey, record.uploadId, parts);
    record.uploadId = null;

    const headResponse = await client.head(record.objectKey);
    const headers = (headResponse && headResponse.res && headResponse.res.headers) || {};
    record.mimeType =
      headers['content-type'] || record.mimeType || 'application/octet-stream';
    record.size = Number(headers['content-length'] || record.size || 0);
    record.lastModified = new Date(
      headers['last-modified'] || Date.now(),
    ).getTime();
    record.etag = normalizeEtag(headers.etag || record.etag);
    record.status = 'uploaded';
    record.playbackKey = record.objectKey;

    let playback;

    if (isMpsConfigured()) {
      await maybeSubmitTranscodeJob(record);
      await ensureTranscodeAssignment(record);
    } else {
      record.status = 'ready';
    }

    playback = await createPlaybackUrl(record.playbackKey || record.objectKey);
    record.playbackUrl = playback.url;
    record.playbackExpiresAt = playback.expiresAt;

    videos.set(videoId, record);

    res.json({
      videoId: record.id,
      status: record.status,
      originalName: record.originalName,
      size: record.size,
      mimeType: record.mimeType,
      playbackUrl: playback.url,
      expiresAt: new Date(playback.expiresAt).toISOString(),
      transcode: record.transcodeJob || null,
    });
  } catch (error) {
    console.error('Failed to complete multipart upload', error);
    res.status(500).json({
      error: 'CompleteMultipartFailed',
      message: 'Failed to finalise multipart upload.',
    });
  }
});

app.post('/api/videos/external', (req, res) => {
  const { url, name } = req.body || {};
  if (!isValidHttpUrl(url)) {
    return res.status(400).json({
      error: 'InvalidUrl',
      message: 'A valid http or https URL is required.',
    });
  }

  const normalizedUrl = url.trim();
  const now = Date.now();
  const displayName = cleanDisplayName(
    name,
    inferDisplayNameFromUrl(normalizedUrl),
  );

  const videoId = nanoid(8);
  const record = {
    id: videoId,
    type: 'external',
    externalUrl: normalizedUrl,
    originalName: displayName,
    status: 'ready',
    size: null,
    mimeType: null,
    createdAt: now,
    lastModified: now,
    objectKey: null,
    playbackKey: null,
  };

  videos.set(videoId, record);

  res.status(201).json({
    videoId: record.id,
    originalName: record.originalName,
    status: record.status,
    size: record.size,
    lastModified: record.lastModified,
    mimeType: record.mimeType,
    type: 'external',
    videoUrl: record.externalUrl,
  });
});

app.get('/api/videos', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const items = [];

  const externalRecords = Array.from(videos.values())
    .filter((record) => record?.type === 'external')
    .sort((a, b) => {
      const left = Number.isFinite(a?.lastModified) ? a.lastModified : a?.createdAt || 0;
      const right = Number.isFinite(b?.lastModified) ? b.lastModified : b?.createdAt || 0;
      return right - left;
    });

  for (const record of externalRecords) {
    items.push({
      videoId: record.id,
      originalName: record.originalName,
      size: record.size,
      lastModified: record.lastModified || record.createdAt,
      status: record.status || 'ready',
      transcodeStatus: record.status || 'ready',
      type: 'external',
    });
    if (items.length >= limit) {
      break;
    }
  }

  if (items.length >= limit || !isOssConfigured()) {
    return res.json({ items });
  }

  const client = getOssClient();
  let marker;

  try {
    while (items.length < limit) {
      const response = await client.list({
        prefix: OSS_VIDEO_PREFIX,
        marker,
        'max-keys': Math.min(limit - items.length, 100),
      });
      const objects = response.objects || [];
      for (const object of objects) {
        if (!object || !object.name || object.name.endsWith('/')) {
          continue;
        }
        const prefixLength = OSS_VIDEO_PREFIX.length;
        const remainder = object.name.slice(prefixLength);
        const slashIndex = remainder.indexOf('/');
        if (slashIndex <= 0) {
          continue;
        }
        const videoId = remainder.slice(0, slashIndex);
        const record = await resolveVideoRecord(videoId);
        if (!record) {
          continue;
        }
        items.push({
          videoId: record.id,
          originalName: record.originalName,
          size: record.size,
          lastModified: record.lastModified,
          status: record.status,
          transcodeStatus: record.transcodeJob?.state || record.status,
          type: record.type || 'oss',
        });
        if (items.length >= limit) {
          break;
        }
      }
      if (!response.isTruncated || items.length >= limit) {
        break;
      }
      marker = response.nextMarker;
    }
  } catch (error) {
    console.error('Failed to list videos from OSS', error);
    return res.status(500).json({
      error: 'ListFailed',
      message: 'Failed to list videos from OSS.',
    });
  }

  res.json({ items });
});

app.get('/api/videos/:id/playback', async (req, res) => {
  const { id } = req.params;
  const record = await resolveVideoRecord(id);
  if (!record) {
    return res.status(404).json({
      error: 'VideoNotFound',
      message: 'Video not found.',
    });
  }

  if (record.type !== 'external' && !isOssConfigured()) {
    return respondOssNotConfigured(res);
  }

  try {
    await ensureTranscodeAssignment(record);
    const playback = await resolvePlaybackForRecord(record);
    record.playbackUrl = playback.url;
    record.playbackExpiresAt = playback.expiresAt;
    videos.set(record.id, record);

    res.json({
      videoId: record.id,
      videoUrl: playback.url,
      expiresAt: playback.expiresAt
        ? new Date(playback.expiresAt).toISOString()
        : null,
      originalName: record.originalName,
      size: record.size,
      mimeType: record.mimeType,
      status: record.status,
      transcodeStatus: record.transcodeJob?.state || record.status,
      source:
        record.type === 'external'
          ? 'external'
          : record.playbackKey === record.objectKey
          ? 'original'
          : 'transcoded',
      type: record.type || 'oss',
    });
  } catch (error) {
    console.error('Failed to generate playback URL', error);
    res.status(500).json({
      error: 'PlaybackUrlFailed',
      message: 'Failed to generate playback URL.',
    });
  }
});

app.get('/api/videos/:id/transcode/status', async (req, res) => {
  const { id } = req.params;
  const record = await resolveVideoRecord(id);
  if (!record) {
    return res.status(404).json({
      error: 'VideoNotFound',
      message: 'Video not found.',
    });
  }

  if (record.type === 'external') {
    return res.json({
      videoId: record.id,
      status: record.status || 'ready',
      transcode: null,
      source: 'external',
      type: 'external',
    });
  }

  if (!isMpsConfigured()) {
    return res.status(503).json({
      error: 'TranscodeDisabled',
      message: 'Transcoding is not enabled for this deployment.',
    });
  }

  await queryTranscodeJob(record);
  await ensureTranscodeAssignment(record);
  videos.set(id, record);

  res.json({
    videoId: record.id,
    status: record.status,
    transcode: record.transcodeJob || null,
    source: record.playbackKey === record.objectKey ? 'original' : 'transcoded',
    type: record.type || 'oss',
  });
});

app.get('/api/rooms/new', (req, res) => {
  const roomId = nanoid(6);
  res.json({ roomId });
});

io.on('connection', (socket) => {
  socket.on('join-room', async ({ roomId, displayName }) => {
    if (!roomId || typeof roomId !== 'string') {
      return;
    }

    const trimmedId = roomId.trim();
    if (!trimmedId) {
      return;
    }

    const room = ensureRoom(trimmedId);

    socket.data.roomId = trimmedId;
    socket.data.displayName = displayName || 'Guest';

    socket.join(trimmedId);
    room.participants.add(socket.id);

    if (!room.hostId) {
      setHost(room, socket.id);
    }

    const state = await prepareStateForClient(room.state);

    socket.emit('room-init', {
      roomId: trimmedId,
      hostId: room.hostId,
      state,
      participantId: socket.id,
    });

    socket.to(trimmedId).emit('participant-joined', {
      participantId: socket.id,
      displayName: socket.data.displayName,
    });
  });

  socket.on('set-video', async ({ videoId, startTime }) => {
    const room = getRoomForSocket(socket);
    if (!room || room.hostId !== socket.id) {
      return;
    }

    if (!videoId || typeof videoId !== 'string') {
      return;
    }

    const record = await resolveVideoRecord(videoId);
    if (!record) {
      return;
    }

    try {
      await ensureTranscodeAssignment(record);
      const playback = await resolvePlaybackForRecord(record);
      const now = Date.now();
      room.state = {
        videoId: record.id,
        videoUrl: playback.url,
        videoName: record.originalName,
        size: record.size,
        status: record.status,
        transcodeStatus: record.transcodeJob?.state || record.status,
        source:
          record.type === 'external'
            ? 'external'
            : record.playbackKey === record.objectKey
            ? 'original'
            : 'transcoded',
        type: record.type || 'oss',
        time: typeof startTime === 'number' ? Math.max(startTime, 0) : 0,
        paused: true,
        playbackRate: 1,
        updatedAt: now,
        ossKey:
          record.type === 'external' ? null : record.playbackKey || record.objectKey,
        playbackExpiresAt: playback.expiresAt || null,
      };
      io.to(socket.data.roomId).emit('load-video', presentState(room.state));
    } catch (error) {
      console.error('Failed to set video for room', error);
    }
  });

  socket.on('host-update', async (payload) => {
    const room = getRoomForSocket(socket);
    if (!room || room.hostId !== socket.id || !room.state) {
      return;
    }

    const nextState = {
      ...room.state,
      ...payload,
      updatedAt: Date.now(),
    };

    room.state = nextState;
    socket.to(socket.data.roomId).emit('sync-state', presentState(nextState));
  });

  socket.on('request-host', async () => {
    const room = getRoomForSocket(socket);
    if (!room) {
      return;
    }

    if (room.hostId === socket.id) {
      socket.emit('host-changed', { hostId: room.hostId });
      return;
    }

    setHost(room, socket.id);
    io.to(socket.data.roomId).emit('host-changed', {
      hostId: room.hostId,
    });

    if (room.state) {
      await ensurePlaybackUrl(room.state);
      socket.emit('sync-state', presentState(room.state));
    }
  });

  socket.on('disconnect', () => {
    const room = getRoomForSocket(socket);
    if (!room) return;

    room.participants.delete(socket.id);
    socket.to(socket.data.roomId).emit('participant-left', {
      participantId: socket.id,
    });

    if (room.hostId === socket.id) {
      const [nextHostId] = room.participants;
      if (nextHostId) {
        setHost(room, nextHostId);
        io.to(socket.data.roomId).emit('host-changed', {
          hostId: room.hostId,
        });
        if (room.state) {
          ensurePlaybackUrl(room.state).then(() => {
            io.to(socket.data.roomId).emit(
              'sync-state',
              presentState(room.state),
            );
          });
        }
      } else {
        rooms.delete(socket.data.roomId);
      }
    }
  });
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
