'use strict'
const path = require('path')
const AdmZip = require('adm-zip');
const cheerio = require('cheerio')

const DC = 'http://purl.org/dc/elements/1.1/'
const DCTERMS = 'http://purl.org/dc/terms/'
const CALIBRE = 'https://calibre-ebook.com'
const CONTAINER = 'urn:oasis:names:tc:opendocument:xmlns:container'
const FOAF = 'http://xmlns.com/foaf/spec/'
const OPF = 'http://www.idpf.org/2007/opf'
const MARC = 'https://www.loc.gov/marc/relators/relacode.html'
const XMLNS = 'http://www.w3.org/2000/xmlns/'

const defaultns = {
  [OPF]: 'opf',
  [DC]: 'dc',
  [DCTERMS]: 'dcterms',
  [CALIBRE]: 'calibre',
  [CONTAINER]: 'oasis',
  [FOAF]: 'foaf',
  [XMLNS]: 'xmlns',
  [MARC]: 'marc'
}

function readText (zip, file) {
  const buf = zip.readFile(file)
  if (!buf) throw new Error('File not found in zip: ' + file)
  return buf.toString()
}

const xmlOpts = {
  trim: true,
  normalizeTags: true,
  normalize: true,
  xmlns: true,
  async: true
}

async function readXML (zip, file) {
  const $ = cheerio.load(await readText(zip, file), {xmlMode: true})
  const self =  function () {
    if (arguments.length && arguments[0].raw) {
      let search = String.raw.apply(this, arguments)
      if (/^(\w+)[$]/.test(search)) {
        const [, ns, name] = /^(\w+)[$](.*)$/.exec(search)
        const full = (self.rprefix[ns] || ns) + '\\:' + name
        return $(full)
      }
      return $(search)
    } else if (arguments.length === 2) {
      const [ns, name] = arguments
      const full = (self.rprefix[ns] || ns) + '\\:' + name
      return $(full)
    } else {
      return $.apply(this, arguments)
    }
  }
  self.prefix = (from, to) => {
    self.fprefix[from] = to
    self.rprefix[to] = from
  }
  self.rprefix = {}
  self.fprefix = {}
  return self
}

function translateAttrs (result, attrs) {
  result.$ = {}
  for (let name of Object.keys(attrs)) {
    const attr = attrs[name]
    result.$[name] = attr.value
  }
  return result
}

function translateTag (result, name, tag) {
  if (tag._) {
    if (tag.$) {
      const value = result = translateAttrs({}, tag.$)
      value._ = tag._
      result[name] = value
    } else {
      result[name] = tag._
    }
  } else {
    const value = translateXML(tag)
    if (value) result[name] = value
  }
  return result
}
function nsName (name, $ns) {
  const prefix = defaultns[$ns.uri]
  return (prefix ? `${prefix}$` : '') + ($ns.local || name)
}
function nsify (name, prefixes) {
  if (!name) return name
  let [, prefix, local] = /^([^:]+)(?::(.*))?$/.exec(name)
  if (!local) return prefix
  if (prefixes[prefix]) prefix = prefixes[prefix]
  return `${prefix}$${local}`
}
function translateXML (xml) {
  let result
  if (xml.$) result = translateAttrs({}, xml.$)
  for (let name of Object.keys(xml)) {
    if (name === '$ns' || name === '$' || name === '_') continue
    if (!result) result = {}
    const tag = xml[name]
    if (Array.isArray(tag)) {
      const final = nsName(name, tag[0].$ns)
      const children = flatMap(tag, _ => {
        const result = translateTag({}, final, _)
        if (result[final]) return result[final]
        return result
      })
      result[final] = children
    } else {
      const final = nsName(name, tag.$ns)
      translateTag(result, final, tag)
    }
  }

  return result
}

async function findMetadataFilename (zip) {
  const $ = await readXML(zip, 'META-INF/container.xml')
  return $`rootfile[media-type="application/oebps-package+xml"]`.attr('full-path')
}

async function readMetadata (zip, metadataFilename) {
  const meta = {}
  const $ = await readXML(zip, metadataFilename)
  const uniqueIdentifier = $`package`.attr('unique-identifier')
  Object.keys(defaultns).forEach(url => {
    $.prefix(defaultns[url], defaultns[url])
  })
  const prefixStr = $`package`.attr('prefix')
  if (prefixStr) prefixStr.match(/\S+:\s*\S+/g).map(_ => {
    const [, name, ns] = /^(\S+):\s*(.*)/.exec(_)
    $.prefix(name,  defaultns[ns] || name)
  })
  const mdattr = $`metadata`.attr()
  Object.keys(mdattr).forEach(md => {
    const [, ns] = /^xmlns:(.*)$/.exec(md)
    if (!ns) return
    $.prefix(ns, defaultns[mdattr[ns]] || ns)
  })
  meta.identifier = $`dc$identifier`.get().map(_ => $(_).text())
  meta.language = $`dc$language`.first().text() || undefined
  meta.title = $`dc$title`.first().text() || undefined
  meta.source = $`dc$source`.first().text() || undefined
  meta.publisher = $`dc$publisher`.first().text() || undefined
  meta.creator = $`dc$creator`.get().map(_ => $(_).text())
  meta.description = $`dc$description`.first().text() || undefined
  meta.date = new Date($`dc$date`.first().text())
  if (isNaN(meta.date)) delete meta.date
  meta.tags = $`dc$subject`.first().text().split(/,/)
  if (meta.tags.length === 1 && meta.tags[0] === '') meta.tags = []
  $`meta`.each((ii, mm) => {
    const $mm = $(mm)
    const property = nsify($mm.attr('property'), $.fprefix)
                  || nsify($mm.attr('name'), $.fprefix)
    if (property === 'dcterms$modified') {
      meta.modified = new Date($mm.text())
    } else if (property === 'calibre$user_metadata:#updated') {
      meta.updated = new Date(JSON.parse($mm.attr('content'))['#value#'])
    } else if (property === 'calibre$user_metadata:#words') {
      meta.words = JSON.parse($mm.attr('content'))['#value#']
    } else if (property === 'calibre$user_metadata:#authorurl') {
      meta.authorurl = JSON.parse($mm.attr('content'))['#value#']
    } else if (property === 'calibre$user_metadata:#status') {
      meta.status = JSON.parse($mm.attr('content'))['#value#']
    } else if (property === 'calibre$user_metadata:#fandom') {
      meta.fandom = JSON.parse($mm.attr('content'))['#value#']
    } else if (property === 'calibre$timestamp') {
      meta.timestamp = new Date($mm.attr('content'))
    } else if (property === 'calibre$title_sort') {
      meta.title_sort = $mm.attr('content')
    } else {
//      console.log(property, $mm.html())
    }
  })
  const navHref = $`item[properties="nav"]`.attr('href')
  const ncxHref = $`item[media-type="application/x-dtbncx+xml"]`.attr('href')
  if (navHref) {
    meta.toc = {type: 'xhtml', filename: resolve(metadataFilename, navHref)}
  } else if (ncxHref) {
    meta.toc = {type: 'ncx', filename: resolve(metadataFilename, ncxHref)}
  }
  return meta
}

function resolve (baseFile, file) {
  return path.resolve('/' + path.dirname(baseFile), file).slice(1)
}

class Chapter {
  constructor (zip, file, name) {
    this.file = file
    this.name = name
    this.zip = zip
  }
  get () {
    return readText(this.zip, this.file)
  }
}

function decodeEntities (html) {
  return html.replace(/&#x([A-Fa-f0-9]+);/g, (_, v) => String.fromCodePoint(parseInt(v, 16)))
             .replace(/&#([0-9]+);/g, (_, v) => String.fromCodePoint(parseInt(v, 10)))
}

async function readXHTMLTOC (zip, filename) {
  const toc = []
  const $ = await readXML(zip, filename)
  $`nav[epub\:type="toc"] li a`.get().map(_ => $(_)).forEach(item => {
    const file = resolve(filename, unescape(item.attr('href').replace(/#.*/, '')))
    let name = decodeEntities(item.text())
    if (/^[ⅰⅱ]?[.] /.test(name)) return
    name = name.replace(/^\d+[.] /, '')
    toc.push(new Chapter(zip, file, name))
  })
  return toc
}

async function readNCXTOC (zip, filename) {
  const toc = []
  const $ = await readXML(zip, filename)
  $`navPoint`.get().map(_ => $(_)).forEach(item => {
    let name = decodeEntities(item.find('navLabel').find('text').html())
    let file = resolve(filename, unescape(item.find('content').attr('src').replace(/#.*/, '')))
    toc.push(new Chapter(zip, file, name))
  })
  return toc
}

module.exports = async function (file) {
  const zip = new AdmZip(file)
  try {
    const mime = readText(zip, 'mimetype')
    if (mime !== 'application/epub+zip') throw new Error('mimetype file not application/epub+zip')
  } catch (ex) {
    console.error('mimetype:', ex)
  }
  const metadataFilename = await findMetadataFilename(zip)
  if (!metadataFilename) throw new Error('could not find oebps content pointer in META-INF/container.xml')
  const meta = await readMetadata(zip, metadataFilename)
  if (meta.toc.type === 'xhtml') {
    meta.toc = await readXHTMLTOC(zip, meta.toc.filename)
  } else if (meta.toc.type === 'ncx') {
    meta.toc = await readNCXTOC(zip, meta.toc.filename)
  } else {
    console.log(meta.toc)
  }
  return meta
}

function flatMap (arr, fn) {
  return arr.map(fn).reduce((acc, val) => {
    if (Array.isArray(val)) {
      acc.push(...val)
    } else {
      acc.push(val)
    }
    return acc
  }, [])
}
