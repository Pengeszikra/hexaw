self.onmessage = async ({data}) => {
  try {
    const module = new WebAssembly.Module(data.bytes);
    const instance = new WebAssembly.Instance(module);
    const result = instance.exports[data.name](...data.args);
    self.postMessage({result});
  } catch (e) { self.postMessage({error:e.message}); }
};
