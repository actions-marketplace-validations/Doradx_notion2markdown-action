const Migrater = require("picgo-plugin-pic-migrater/dist/lib/Migrater.js");
const FileHandler = require("picgo-plugin-pic-migrater/dist/lib/FileHandler.js");
const crypto = require("crypto");
const axios = require("axios");

const imagemin = require("imagemin");
const imageSize = require("image-size");
const imageminPngquant = require("imagemin-pngquant");
const imageminMozjpeg = require("imagemin-mozjpeg");
const imageminGifsicle = require("imagemin-gifsicle");
const imageminSvgo = require("imagemin-svgo");


class NotionMigrater extends Migrater.default {
  async getPicFromURL(url) {
    return this.ctx.request({
      url,
      encoding: null,
      responseType: "arraybuffer",
    });
  }

  async handlePicFromURL(url) {
    try {
      if (url.includes("data:image/svg+xml")) {
        let data = url.replace("data:image/svg+xml;utf8,", "");
        return {
          buffer: Buffer.from(decodeURIComponent(data), "utf-8"),
          fileName: `${new Date().getTime()}.svg`,
          extname: ".svg",
          origin: url,
        };
      }
      return super.handlePicFromURL(url);
    } catch (e) {
      this.ctx.log.error(`get pic from url fail: ${e}`);
      return undefined;
    }
  }

  async migrate() {
    const originTransformer = this.ctx.getConfig('picBed.transformer') || null;
    this.ctx.setConfig({
      'picBed.transformer': 'base64'
    });
    this.ctx.output = []; // a bug before picgo v1.2.2
    const include = this.ctx.getConfig('picgo-plugin-pic-migrater.include') || null;
    const exclude = this.ctx.getConfig('picgo-plugin-pic-migrater.exclude') || null;
    const base_url = this.ctx.getConfig('pic-base-url') || null;
    const includesReg = new RegExp(include);
    const excludesReg = new RegExp(exclude);
    const result = {
      urls: [],
      success: 0,
      exists: 0,
      total: 0
    };
    if (!this.urlArray || this.urlArray.length === 0) {
      return result;
    }
    // filter the url using include and exclude
    const toUploadURLs = this.urlArray.filter(url => ((!include || includesReg.test(url)) && (!exclude || !excludesReg.test(url)))).map(async (url) => {
      return await new Promise(async (resolve, reject) => {
        result.total += 1;
        try {
          let imgInfo;
          const picPath = this.getLocalPath(url);
          if (!picPath) {
            imgInfo = await this.handlePicFromURL(url);
          }
          else {
            imgInfo = await this.handlePicFromLocal(picPath, url);
          }
          resolve(imgInfo);
        }
        catch (err) {
          // dont reject
          resolve(undefined);
          this.ctx.log.error(err);
        }
      });
    });
    var toUploadImgs = await Promise.all(toUploadURLs).then(imgs => imgs.filter(img => img !== undefined));
    // compress the image if the config is set
    if (this.ctx.getConfig('compress')) {
      toUploadImgs = await Promise.all(toUploadImgs.map(async (item) => {
        return await imagemin.buffer(item.buffer, {
          plugins: [
            imageminPngquant(),
            imageminMozjpeg(),
            imageminGifsicle(),
            imageminSvgo()
          ],
        }).then((buffer) => {
          item.buffer = buffer;
          // update image width and height based on the new buffer
          const { width, height } = imageSize(buffer);
          item.width = width;
          item.height = height;
          item.fileName = `${crypto.createHash("md5").update(buffer).digest("hex")}${item.extname}`;
          // update the buffer
          return item;
        });
      }));
    }
    // 文件重命名为 md5 hash
    toUploadImgs.forEach((item) => {
      item.fileName =
        crypto.createHash("md5").update(item.buffer).digest("hex") + item.extname;
    });
    /**
     * check the url if it is already uploaded, if base_url is set
     */
    if (base_url) {
      // check if the file exists on the server
      const existsImgs = await Promise.all(toUploadImgs.map(async (item) => {
        const url = `${base_url}${item.fileName}`;
        try {
          const res = await axios.head(url);
          if (res && res.status === 200) {
            console.log(`Image ${url} exists`);
            return {
              original: item.origin,
              new: url
            };
          }
        } catch (e) {
          if (axios.isAxiosError(e) && e.response && e.response.status === 404) {
            console.log(`Image ${url} not exists on pic bed.`);
            return null;
          }
          console.warn(`Some error happened when checking image ${url}, ${e}`);
        }
        console.log(`Image ${url} not exists`);
        return null;
      }));
      result.urls = result.urls.concat(existsImgs.filter(item => item !== null));
      result.exists = result.urls.length;
      // remove the result.urls from toUploadImgs
      toUploadImgs = toUploadImgs.filter((item, index) => {
        return !existsImgs[index];
      });
    }
    // upload
    let output = [];
    if (toUploadImgs && toUploadImgs.length > 0) {
      if (this.guiApi) {
        output = await this.guiApi.upload(toUploadImgs);
      }
      else {
        try {
          const res = await this.ctx.upload(toUploadImgs);
          if (Array.isArray(res)) {
            output = res;
          }
        }
        catch (e) {
          // fake output
          this.ctx.log.error(e);
          output = this.ctx.output;
        }
      }
    }
    // merge the result
    result.urls = result.urls.concat(output.filter(item => item.imgUrl && item.imgUrl !== item.origin).map(item => {
      return {
        original: item.origin,
        new: item.imgUrl
      };
    }));
    result.success = result.urls.length;
    this.ctx.setConfig({
      'picBed.transformer': originTransformer // for GUI reset config
    });
    return result;
  }
}

class NotionFileHandler extends FileHandler.default {
  getUrlListFromFileContent(file) {
    const content = this.fileList[file] || "";
    const markdownURLList = (content.match(/\!\[.*\]\(.*\)/g) || [])
      .map((item) => {
        const res = item.match(/\!\[.*\]\((.*?)( ".*")?\)/);
        if (res) {
          return res[1];
        }
        return null;
      })
      .filter((item) => item);

    const imageTagURLList = (content.match(/<img.*?(?:>|\/>)/gi) || [])
      .map((item) => {
        const res = item.match(/src=[\'\"]?(.*?)[\'\"]/i);
        if (res) return res[1];
        return null;
      })
      .filter((item) => item);

    let urls = markdownURLList.concat(imageTagURLList);

    // front matter
    let matchs = content.matchAll(/(.*):\s((https?:\/\/.*\.(?:png|jpg|jpeg|gif|svg|tif)).*)/gi);
    for (const m of matchs) {
      let src = m[2];
      src = src.replace(/^'/, "").replace(/'$/, "");
      src = src.replace(/^"/, "").replace(/"$/, "");
      src = src.trim();
      if (!src) continue;
      urls.push(src);
    }

    this.urlList[file] = {};
    for (const url of urls) {
      this.urlList[file][url] = url;
    }
    console.log(`file: ${file}, urls: ${urls}`); 
  }
}

async function migrate(ctx, files) {
  ctx.log.info("Migrating...");

  let total = 0;
  let success = 0;

  for (const file of files) {
    const fileHandler = new NotionFileHandler(ctx);
    // read File
    fileHandler.read(file);
    const migrater = new NotionMigrater(ctx, null, file);
    migrater.init(fileHandler.getFileUrlList(file));

    // migrate pics
    const result = await migrater.migrate();

    if (result.total === 0) continue;

    total += result.total;
    success += result.success;
    if (result.success === 0) {
      ctx.log.warn(
        `Please check your configuration, since no images migrated successfully in ${file}`
      );
      return;
    }
    let content = fileHandler.getFileContent(file);
    // replace content
    result.urls.forEach((item) => {
      content = content.replaceAll(item.original, item.new);
    });
    fileHandler.write(file, content, "", true);
  }
  return { total, success };
}

module.exports = migrate;
