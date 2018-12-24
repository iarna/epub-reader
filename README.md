# @iarna/epub-reader

A very minimal epub-reader, focused on reading epub related metadata.

## EXAMPLE

```
const epubReader = require('epub-reader')
const info = await epubReader('filename.epub')
```

## DESCRIPTION

This should be able to read epub2 and epub3 type documents with reasonable fidelity. 

**info** has the following metadata extracted from Dublin Core fields of the
same name, with the exception of `tags` which is an array produced by
splitting the `subject` field on commas.

```
  identifier
  language
  title
  source
  publisher
  creator
  description
  date
  tags
  modified
  toc: [...chapters]
```

It also has the following calibre specific metadata:

```
  timestamp
  title_sort
```

And finally it understands the following calibre custom fields:
```
  updated
  words
  authorurl
  status
  fandom
```

**chapters** have `file` and `name` properties and a `get` method that will get the content of the chapter out of the epub.
