export const bundledOffline = () => globalThis.__UNILAB_OFFLINE__ === true;
export const offlineAsset = path => new URL(`${import.meta.env.BASE_URL}offline/${path}`,document.baseURI).href;
