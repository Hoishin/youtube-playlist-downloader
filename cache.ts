import path from "path";
import cacache from "cacache";

const cachePath = path.resolve(__dirname, "node_modules/.cache");

export const saveStream = (id: string) => {
	return cacache.put.stream(cachePath, id);
};

export const find = async (id: string) => {
	const list = await cacache.ls(cachePath);
	return Boolean(list[id]);
};

export const getStream = (id: string) => {
	return cacache.get.stream(cachePath, id);
};

export const remove = async (id: string) => {
	return cacache.rm.entry(cachePath, id);
};
