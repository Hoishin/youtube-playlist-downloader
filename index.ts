import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import ytdl from "ytdl-core";
import PQueue from "p-queue";
import { google } from "googleapis";
import sanitizeFilename from "sanitize-filename";

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

const downloadVideo = (url: string, destDir: string) => {
	return new Promise((resolve) => {
		const videoStream = ytdl(url);

		videoStream.on("info", (info) => {
			const title = sanitizeFilename(info.videoDetails.title);
			const writeStream = fs.createWriteStream(
				path.resolve(destDir, `${title}.mp4`)
			);
			videoStream.pipe(writeStream);
		});

		videoStream.on("end", () => {
			console.log(url);
			resolve(undefined);
		});
	});
};

const queue = new PQueue({ concurrency: parseInt(concurrency) });
const bulkDownloadVideos = async (urls: string[], playlistTitle: string) => {
	const destDir = path.resolve(OUTDIR, sanitizeFilename(playlistTitle));
	await fs.promises.mkdir(destDir, { recursive: true });
	for (const url of urls) {
		queue.add(() => downloadVideo(url, destDir));
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
	Promise.all([getPlaylistVideos(playlistId), getPlaylistTitle(playlistId)])
		.then(([videoIds, playlistTitle]) => {
			bulkDownloadVideos(videoIds, playlistTitle);
		})
		.catch((error) => {
			console.error(error);
		});
}
