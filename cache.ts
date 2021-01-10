import path from "path";
import cacache from "cacache";

const cachePath = path.resolve(__dirname, "node_modules/.cache");

export const algorithm = "md5";

export const saveStream = (id: string, etag: string) => {
	return cacache.put.stream(cachePath, id, {
		algorithms: [algorithm],
		metadata: { etag },
	});
};

export const find = async (id: string, etag: string) => {
	const list = await cacache.ls(cachePath);
	return list[id]?.metadata?.etag === etag ? list[id] : false;
};

export const getStream = (id: string) => {
	return cacache.get.stream(cachePath, id);
};

export const remove = async (id: string) => {
	return cacache.rm.entry(cachePath, id);
};
