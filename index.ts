import { Hono } from 'hono'
import { serveStatic } from "hono/bun";
import ffmpeg from 'fluent-ffmpeg';
import { streamSSE } from "hono/streaming";

const messages: string[] = [];
const app = new Hono();

// static file serving
app.use('/video/*', serveStatic({
    root: './uploads/',
    rewriteRequestPath: (path) => path.replace('/video', ''),
}));
app.use('/enc.key', serveStatic({ path: './enc.key' }));

// page entry point
app.get('/', async (c) => {
    const html = await Bun.file(import.meta.dir + '/templates/index.html').text();
    return c.html(html);
});

// video encryption progress
let id = 0;
app.get('/video-progress', async (c) => {
    return streamSSE(c, async (stream) => {
        while (true) {
            const message = messages.pop();
            if (message === undefined) {
                await stream.sleep(100)
                continue
            }
            await stream.writeSSE({
                data: message,
                event: 'message',
                id: String(id++),
            })
            await stream.sleep(100);
        }
    })
})

async function encryptVideo(video: File): Promise<string> {
    return new Promise(async (resolve, reject) => {
        // save the original video just in case
        const originalVideoPath = import.meta.dir + '/uploads/original/' + video.name;
        await Bun.write(originalVideoPath, video);

        // encrypt the video with ffmpeg using aes-256-cbc
        const encryptedPlaylist = import.meta.dir + '/uploads/encrypted/' + video.name.split('.').shift() + '.m3u8';
        const segmentPath = import.meta.dir + '/uploads/encrypted/' + video.name + '__segment%03d.ts';
        ffmpeg()
            .input(originalVideoPath)
            .outputOptions([
                '-hls_flags', 'split_by_time',
                '-hls_time', '9',
                '-hls_key_info_file', 'enc.keyinfo',
                '-hls_playlist_type', 'vod',
                '-hls_segment_filename', segmentPath,
            ])
            .save(encryptedPlaylist)
            .on('start', (cmd) => {
                const message = 'Started ffmpeg with command: ' + cmd;
                console.log(message);
            })
            .on('progress', (progress) => {
                const message = 'Processing: ' + progress.timemark;
                console.log(message);
                messages.push(message);
            })
            .on('end', () => {
                const message = 'Finished processing video';
                console.log(message);
                messages.push(message);
                resolve(encryptedPlaylist);
            })
            .on('error', (err) => {
                reject(err);
            });
    });
}

app.post('/video-upload', async (c) => {
    const body = await c.req.parseBody();
    const video = body['video'] as File;

    // save the original and encrypt the video
    let start = 0, end = 0;
    try {
        start = Bun.nanoseconds()
        console.log("Encrypting video...");
        await encryptVideo(video);
    } catch (err) {
        console.error(err);
        return c.text('Failed to encrypt video: ' + err);
    } finally {
        end = Bun.nanoseconds();
        console.log("Video encrypted, took: " + (end - start) / 1e6 + "ms");
    }

    // replace the markup with the video
    const videoTemplate = await Bun.file(import.meta.dir + '/templates/video.html').text();
    const playlistUrl = video.name.split('.').shift() + '.m3u8';
    return c.text(videoTemplate.replace('@playlistName', playlistUrl));
});

export default {
    fetch: app.fetch,
    tls: {
        cert: Bun.file("cert.pem"),
        key: Bun.file("key.pem"),
    },
};