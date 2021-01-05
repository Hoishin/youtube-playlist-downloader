import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import ytdl from "ytdl-core";
import PQueue from "p-queue";
import { google } from "googleapis";
import sanitizeFilename from "sanitize-filename";
import * as cache from "./cache";

// Import and validate .env configuration
dotenv.config();
const playlistIds = process.env.PLAYLISTS?.split(",");
if (!playlistIds) {
	throw new Error("Empty playlist in config");
}
const OUTDIR = process.env.OUTDIR;
if (!OUTDIR) {
	throw new Error("Empty outdir in config");
}
const concurrency = process.env.DOWNLOAD_CONCURRENCY || "5";

// Setup Google API
const service = google.youtube("v3");
const auth = new google.auth.GoogleAuth({
	keyFile: path.resolve(__dirname, "service-account.json"),
	scopes: "https://www.googleapis.com/auth/youtube.readonly",
});

const downloadVideo = async (id: string, destDir: string) => {
	const info = await ytdl.getInfo(id);
	const title = sanitizeFilename(info.videoDetails.title);
	const writeStream = fs.createWriteStream(
		path.resolve(destDir, `${title}.mp4`)
	);

	const cacheExists = await cache.find(id);
	if (cacheExists) {
		console.log(`Using cache for ${id}`)
		cache.getStream(id).pipe(writeStream);
		return;
	}

	console.log(`Started downloading ${id}...`);

	const videoStream = ytdl.downloadFromInfo(info);

	videoStream.pipe(writeStream);
	videoStream.pipe(cache.saveStream(id));

	videoStream.on("error", (error) => {
		console.error(`Failed to fetch video ${id}`, error);
	});

	return new Promise((resolve) => {
		videoStream.on("end", () => {
			console.log(`Finished downloading ${id}`);
			resolve(undefined);
		});
	});
};

const queue = new PQueue({ concurrency: parseInt(concurrency) });
const bulkDownloadVideos = async (urls: string[], destDir: string) => {
	for (const url of urls) {
		queue.add(() =>
			downloadVideo(url, destDir).catch((error) => {
				console.error(`Failed to download video ${url}`, error);
			})
		);
	}
};

const getPlaylistTitle = async (playlistId: string) => {
	const { data } = await service.playlists.list({
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
	oldList: string[] = [],
	pageToken?: string
): Promise<string[]> => {
	const { data } = await service.playlistItems.list({
		part: ["contentDetails"],
		playlistId,
		maxResults: 50,
		auth,
		pageToken,
	});

	const thisPageVideoIds = data.items?.map((item) => {
		const id = item.contentDetails?.videoId;
		if (!id) {
			throw new Error("Empty video ID");
		}
		return id;
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
		await fs.promises.mkdir(destDir, { recursive: true });
		bulkDownloadVideos(videoIds, destDir);
	})();
}
