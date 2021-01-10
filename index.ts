import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import ytdl from "ytdl-core";
import PQueue from "p-queue";
import pEvent from "p-event";
import {google} from "googleapis";
import sanitizeFilename from "sanitize-filename";
import hasha from "hasha";
import * as cache from "./cache";
import {MultiBar, Presets} from "cli-progress";

// Import and validate .env configuration
dotenv.config();
const playlistIds = process.env.PLAYLISTS?.split(",");
if (!playlistIds || playlistIds.length === 0) {
	throw new Error("Empty playlist in config");
}
const OUTDIR = process.env.OUTDIR;
if (!OUTDIR) {
	throw new Error("Empty outdir in config");
}

const concurrency = process.env.DOWNLOAD_CONCURRENCY || "5";

const queue = new PQueue({concurrency: parseInt(concurrency)});

// Setup Google API
const service = google.youtube("v3");
const auth = new google.auth.GoogleAuth({
	keyFile: path.resolve(__dirname, "service-account.json"),
	scopes: "https://www.googleapis.com/auth/youtube.readonly",
});

const progressBar = new MultiBar(
	{
		clearOnComplete: false,
		hideCursor: true,
		format: "{bar} | {id} | {percentage}% | {status}",
	},
	Presets.shades_classic,
);

const downloadVideo = async (id: string, etag: string, destDir: string) => {
	const bar = progressBar.create(100, 0, {id, status: "pending"});
	const info = await ytdl.getInfo(id);
	const filePath = path.resolve(
		destDir,
		`${sanitizeFilename(info.videoDetails.title)}.webm`,
	);
	const cacheInfo = await cache.find(id, etag);
	if (cacheInfo) {
		bar.update(0, {status: "using cache"});
		const cacheHash = cacheInfo.integrity;
		const existingFileHash = await hasha.fromFile(filePath, {
			encoding: "base64",
			algorithm: cache.algorithm,
		});
		if (cacheHash === `${cache.algorithm}-${existingFileHash}`) {
			bar.update(100, {status: "hash matched"});
		} else {
			bar.update(0, {status: "copying cache"});
			const totalSize = cacheInfo.size;
			let downloadedSize = 0;
			const cacheStream = cache.getStream(id);
			const writeStream = fs.createWriteStream(filePath);
			cacheStream.pipe(writeStream);
			cacheStream.on("data", (data) => {
				downloadedSize += data.size;
				bar.update(downloadedSize / totalSize);
			});
			await pEvent(cacheStream, "end");
			bar.update(100, {status: "cache copy done"});
		}
	} else {
		bar.update(0, {status: "downloading"});
		const format = ytdl.chooseFormat(info.formats, {
			quality: "highest",
			filter: (format) => format.container === "webm",
		});
		const writeStream = fs.createWriteStream(filePath);
		const videoStream = ytdl(id, {
			quality: "highest",
			filter: "video",
			format,
		});
		videoStream.pipe(writeStream);
		videoStream.pipe(cache.saveStream(id, etag));
		videoStream.on("progress", (_, downloaded, total) => {
			bar.update(downloaded / total);
		});
		await pEvent(videoStream, "end");
		bar.update(100, {status: "downloading done"});
	}
};

const bulkDownloadVideos = async (
	videos: {id: string; etag: string}[],
	destDir: string,
) => {
	for (const video of videos) {
		queue.add(() =>
			downloadVideo(video.id, video.etag, destDir).catch((error) => {
				console.error(error);
			}),
		);
	}
};

const getPlaylistTitle = async (playlistId: string) => {
	const {data} = await service.playlists.list({
		part: ["snippet"],
		id: [playlistId],
		auth,
	});
	const title = data.items?.[0].snippet?.title;
	if (!title) {
		throw new Error(`Empty playlist title: ${playlistId}`);
	}
	return title;
};

const getPlaylistVideos = async (
	playlistId: string,
	oldList: {id: string; etag: string}[] = [],
	pageToken?: string,
): Promise<{id: string; etag: string}[]> => {
	const {data} = await service.playlistItems.list({
		part: ["contentDetails", "snippet"],
		playlistId,
		maxResults: 50,
		auth,
		pageToken,
	});

	const thisPageVideoIds = data.items?.map((item) => {
		const id = item.contentDetails?.videoId;
		const etag = item.etag;
		if (!id || !etag) {
			throw new Error("Empty video ID or etag");
		}
		return {id, etag};
	});
	const newList = [...oldList, ...(thisPageVideoIds || [])];
	if (data.nextPageToken) {
		return getPlaylistVideos(playlistId, newList, data.nextPageToken);
	}
	return newList;
};

for (const playlistId of playlistIds) {
	(async () => {
		const [videoIds, playlistTitle] = await Promise.all([
			getPlaylistVideos(playlistId),
			getPlaylistTitle(playlistId),
		]);
		const destDir = path.resolve(OUTDIR, sanitizeFilename(playlistTitle));
		await fs.promises.mkdir(destDir, {recursive: true});
		await bulkDownloadVideos(videoIds, destDir);
	})();
}
