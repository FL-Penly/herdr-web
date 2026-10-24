import { describe, expect, test } from 'bun:test'
import {
  activityLabel,
  attachmentChips,
  commonPrefix,
  compactNumber,
  duration,
  elidePath,
  embedAttachments,
  isCompactCell,
  isProseColumn,
  prettyModel,
  relativeTime,
  sentMessageKey,
  shortCwd,
  terminalTitle,
  uploadDisplayName,
  uploadName,
  uploadParts,
} from '../../public/js/format.js'

describe('duration', () => {
  test('seconds, minutes, hours', () => {
    expect(duration(0)).toBe('0s')
    expect(duration(59_400)).toBe('59s')
    expect(duration(61_000)).toBe('1m 1s')
    expect(duration(3_600_000 + 120_000)).toBe('1h 2m')
  })

  test('never negative', () => {
    expect(duration(-5000)).toBe('0s')
  })
})

describe('relativeTime', () => {
  const now = 1_700_000_000_000
  test('just now under a minute', () => {
    expect(relativeTime(now - 30_000, { now, justNow: 'now' })).toBe('now')
  })

  test('compact minutes, hours and days', () => {
    expect(relativeTime(now - 5 * 60_000, { now })).toBe('5m')
    expect(relativeTime(now - 3 * 3_600_000, { now })).toBe('3h')
    expect(relativeTime(now - 2 * 86_400_000, { now })).toBe('2d')
  })
})

describe('compactNumber', () => {
  test('abbreviates large counts', () => {
    expect(compactNumber(1234, 'en')).toBe('1.2K')
    expect(compactNumber(12, 'en')).toBe('12')
  })
})

describe('shortCwd', () => {
  test('replaces the home directory with ~', () => {
    expect(shortCwd('/home/alice/project', '/home/alice')).toBe('~/project')
    expect(shortCwd('/home/alice', '/home/alice')).toBe('~')
    expect(shortCwd('/Users/bob/src/app', '/Users/bob')).toBe('~/src/app')
  })

  test('leaves other paths and lookalike prefixes alone', () => {
    expect(shortCwd('/home/alice2/x', '/home/alice')).toBe('/home/alice2/x')
    expect(shortCwd('/srv/data', '/home/alice')).toBe('/srv/data')
    expect(shortCwd('/srv/data', '')).toBe('/srv/data')
    expect(shortCwd('/srv/data', '/')).toBe('/srv/data')
  })

  test('tolerates missing input', () => {
    expect(shortCwd(null, '/home/alice')).toBe('')
    expect(shortCwd(undefined, '/home/alice')).toBe('')
  })
})

describe('terminalTitle', () => {
  test('strips the user@host prefix of shell titles', () => {
    expect(terminalTitle({ title: 'alice@devbox: /home/alice/project', cwd: '/x' }, '/home/alice')).toBe('~/project')
  })

  test('falls back to the cwd, then to empty', () => {
    expect(terminalTitle({ title: '', cwd: '/home/alice/src' }, '/home/alice')).toBe('~/src')
    expect(terminalTitle(undefined, '/home/alice')).toBe('')
  })
})

describe('prettyModel', () => {
  test('Claude ids', () => {
    expect(prettyModel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(prettyModel('claude-opus-5-5[1m]')).toBe('Opus 5.5 (1M)')
    expect(prettyModel('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5')
    expect(prettyModel('claude-haiku-4-5-20251001[1m]')).toBe('Haiku 4.5 (1M)')
  })

  test('GPT ids and unknown names', () => {
    expect(prettyModel('gpt-5.1-codex')).toBe('GPT-5.1-codex')
    expect(prettyModel('my-model')).toBe('my-model')
    expect(prettyModel('')).toBe('')
  })
})

describe('activityLabel', () => {
  test('cuts the status at its first parenthesis', () => {
    expect(activityLabel('Thinking… (12s · esc to interrupt)')).toBe('Thinking…')
    expect(activityLabel('Reading files (3s · ↓ 1.2k tokens)')).toBe('Reading files')
    expect(activityLabel('思考中（按 esc 中断）')).toBe('思考中')
  })

  test('empty for nothing', () => {
    expect(activityLabel(null)).toBe('')
    expect(activityLabel('')).toBe('')
  })
})

describe('uploadName', () => {
  test('keeps real names', () => {
    expect(uploadName({ name: 'diagram.png', type: 'image/png' })).toBe('diagram.png')
  })

  test('names pasted images uniquely', () => {
    expect(uploadName({ name: 'image.png', type: 'image/png' }, 42)).toBe('paste-42.png')
    expect(uploadName({ name: '', type: 'image/jpeg' }, 7)).toBe('paste-7.jpg')
    expect(uploadName({ type: '' }, 1)).toBe('paste-1.png')
  })
})

describe('uploads in messages', () => {
  const dir = '/run/user/1000/herdr-web/uploads'

  test('paths into the upload dir become named files, the rest stays text', () => {
    const text = `Read this screenshot\n${dir}/20261024012727-e85551-example.png\n${dir}/20261024012730-a1b2c3-notes.txt`
    expect(uploadParts(text)).toEqual({
      text: 'Read this screenshot',
      files: [
        { path: `${dir}/20261024012727-e85551-example.png`, name: 'example.png', image: true },
        { path: `${dir}/20261024012730-a1b2c3-notes.txt`, name: 'notes.txt', image: false },
      ],
    })
  })

  test('a message that is only an upload has no text; unrelated paths are left alone', () => {
    expect(uploadParts(`${dir}/20261024012727-e85551-截图.jpeg`)).toEqual({
      text: '',
      files: [{ path: `${dir}/20261024012727-e85551-截图.jpeg`, name: '截图.jpeg', image: true }],
    })
    const plain = 'see /tmp/uploads/a.png and ~/herdr-web/uploads-old/x'
    expect(uploadParts(plain)).toEqual({ text: plain, files: [] })
    expect(uploadDisplayName(`${dir}/20261024012727-e85551-paste-1.png`)).toBe('paste-1.png')
  })
})

describe('sentMessageKey', () => {
  test('a sent message matches its transcript copy with image markers', () => {
    const dir = '/home/u/.cache/herdr-web/uploads'
    const sent = `Describe the colour of the image.\n${dir}/20261024012727-e85551-shot.png`
    expect(sentMessageKey(sent)).toBe('Describethecolouroftheimage.')
    expect(sentMessageKey('[Image #1]Describe the colour of the image.')).toBe(sentMessageKey(sent))
    expect(sentMessageKey('[Image #1] [Image #2]')).toBe('')
  })
})

describe('table cells', () => {
  test('numbers and short ids stay on one line; prose wraps', () => {
    expect(['50', '1,024', '12:30', '99%', 'cafe-中文', '--json'].map(isCompactCell)).toEqual(Array(6).fill(true))
    expect(['', 'Plain text 默认', 'a-very-long-identifier-name'].map(isCompactCell)).toEqual([false, false, false])
  })

  test('a column of sentences gets a reading width; words and ids do not', () => {
    expect(isProseColumn(['Example', 'I found my glasses under the sofa.'])).toBe(true)
    expect(isProseColumn(['例句', '我在沙发下面找到了我的眼镜和钥匙。'])).toBe(true)
    expect(isProseColumn(['English word', 'apple', 'a-very-long-identifier-name-without-spaces'])).toBe(false)
    expect(isProseColumn(['#', '1', '2'])).toBe(false)
  })
})

describe('commonPrefix', () => {
  test('what every completion shares', () => {
    expect(commonPrefix(['~/projects/app', '~/projects/api'])).toBe('~/projects/ap')
    expect(commonPrefix(['/a'])).toBe('/a')
    expect(commonPrefix([])).toBe('')
  })
})

describe('elidePath', () => {
  test('keeps the start and the nearest folders of a long path', () => {
    expect(elidePath('~/projects/app')).toBe('~/projects/app')
    expect(elidePath('/data00/home/me/project/open_source/herdr-web', 36)).toBe('/data00/…/open_source/herdr-web')
    expect(elidePath('~/a-very-long-folder-name/another-long-one/x', 20)).toBe('~/…/x')
  })
})

describe('attachment tokens', () => {
  const up = (name: string) => `/run/user/1/herdr-web/uploads/20261024092432-527d27-${name}`

  test('each path goes right after its token; one without a token goes at the end', () => {
    const items = [
      { token: '[图片1]', path: up('a.png') },
      { token: '[附件1]', path: up('b.pdf') },
      { token: '[图片2]', path: up('c.png') },
    ]
    expect(embedAttachments('你好[图片1]看看这个，还有[附件1]', items)).toBe(
      `你好[图片1] ${up('a.png')} 看看这个，还有[附件1] ${up('b.pdf')}\n[图片2] ${up('c.png')}`,
    )
    expect(embedAttachments('', [{ token: '', path: up('x.txt') }])).toBe(up('x.txt'))
  })

  test('a sent message: tokens with their paths, or with the marker Claude Code left for an image', () => {
    const sent = `你好[图片1] ${up('a.png')} 看看[附件1] ${up('b.pdf')}`
    expect(attachmentChips(sent)).toEqual({
      text: '你好\u00010\u0001 看看\u00011\u0001',
      chips: [
        { label: '图片1', path: up('a.png'), image: true },
        { label: '附件1', path: up('b.pdf'), image: false },
      ],
      images: 0,
    })
    const claude = attachmentChips('[Image 1] [Image #3] and [Image 2] [Image #4]', [up('a.png')])
    expect(claude.chips).toEqual([
      { label: 'Image 1', path: up('a.png'), image: true },
      { label: 'Image 2', path: null, image: true },
    ])
    expect(claude.images).toBe(2)
    expect(attachmentChips('just [图片1] typed').chips).toEqual([])
    // A message sent while Claude Code worked: its image markers come first, the tokens stay where they were typed.
    const queued = attachmentChips('[Image #23]如图[图片1]，还有[附件1]', [up('a.png')])
    expect(queued.text).toBe('如图\u00010\u0001，还有[附件1]')
    expect(queued.chips).toEqual([{ label: '图片1', path: up('a.png'), image: true }])
    expect(queued.images).toBe(1)
  })

  test('the message this tab sent and the transcript copy share a key', () => {
    expect(sentMessageKey('你好[图片1]看看')).toBe(sentMessageKey('你好[图片1] [Image #1] 看看'))
  })
})
