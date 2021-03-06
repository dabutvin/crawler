// Copyright (c) Microsoft Corporation and others. Licensed under the MIT license.
// SPDX-License-Identifier: MIT

const tmp = require('tmp')
const semver = require('semver')
const EntitySpec = require('../lib/entitySpec')
const extract = require('extract-zip')
const decompress = require('decompress')
const decompressTar = require('decompress-tar')
const decompressTargz = require('decompress-targz')
const decompressUnzip = require('decompress-unzip')
const fs = require('fs')
const path = require('path')
const glob = require('fast-glob')
const shajs = require('sha.js')

tmp.setGracefulCleanup()
const tmpOptions = {
  unsafeCleanup: true,
  template: (process.platform === 'win32' ? 'c:/temp/' : '/tmp/') + 'cd-XXXXXX'
}

function buildGlob(roots) {
  const parts = []
  roots.forEach(root => {
    parts.push(root)
    parts.push(`${root}.{md,txt,html}`)
  })
  return `+(${parts.join('|')})`
}

class BaseHandler {
  constructor(options) {
    this.options = options
    this.logger = options.logger
  }

  static computeToken(content) {
    return shajs('sha256')
      .update(content)
      .digest('hex')
  }

  static async attachInterestinglyNamedFiles(document, location, folder = '') {
    if (!location && location !== '') return null
    const patterns = [
      'license',
      'license-mit',
      'license-apache',
      'unlicense',
      'copying',
      'notice',
      'notices',
      'contributors',
      'patents'
    ]
    const files = await glob(buildGlob(patterns), {
      cwd: path.join(location, folder),
      nocase: true,
      onlyFiles: true
    })
    if (files.length === 0) return null
    const paths = files.map(file => path.join(folder, file))
    BaseHandler.attachFiles(document, paths, location)
  }

  /**
   * Attach the files at the given `paths` (relative to the identified `location`) to the document
   *
   * @param {Object} document - The document to host the attachments
   * @param {[string]} files - Relative paths to the attachment files
   * @param {string} location - Root filesystem path that hosts the files to be attached
   */
  static attachFiles(document, files, location) {
    if (!files || !files.length) return
    if (!document._attachments) Object.defineProperty(document, '_attachments', { value: [], enumerable: false })
    document.attachments = document.attachments || []
    files.forEach(file => {
      const fullPath = path.join(location, file)
      const attachment = fs.readFileSync(fullPath, 'utf8')
      const token = BaseHandler.computeToken(attachment)
      // Stash the actual content on a hidden prop on the document and note the file in the list of attachments
      document._attachments.push({ path: file, token, attachment })
      document.attachments.push({ path: file, token })
    })
  }

  // Helper to take merge multiple semvers into one. This is useful where one handler is made up of
  // multiple tools. The handler's version can be the sum of its composite tools versions
  static _aggregateVersions(versions, errorRoot, base = '0.0.0') {
    return versions
      .reduce((result, version) => {
        const parts = version.split('.')
        if (parts.length !== 3 || parts.some(part => isNaN(+part))) throw new Error(`${errorRoot}: ${version}`)
        for (let i = 0; i < 3; i++) result[i] += +parts[i]
        return result
      }, base.split('.').map(n => +n))
      .join('.')
  }

  get tmpOptions() {
    const tmpBase = this.options.tempLocation || (process.platform === 'win32' ? 'c:/temp/' : '/tmp/')
    return {
      unsafeCleanup: true,
      template: tmpBase + 'cd-XXXXXX'
    }
  }

  shouldFetch() {
    return true
  }

  canHandle() {
    return false
  }

  shouldProcess(request) {
    return request.policy.shouldProcess(request, this.schemaVersion)
  }

  shouldTraverse(request) {
    return request.policy.shouldTraverse(request)
  }

  isProcessing(request) {
    return request.processMode === 'process'
  }

  _process(request) {
    request.document._metadata.version = this.schemaVersion || 1
    return { document: request.document, spec: this.toSpec(request) }
  }

  _createTempFile(request) {
    const result = tmp.fileSync(tmpOptions)
    request.trackCleanup(result.removeCallback)
    return result
  }

  _createTempDir(request) {
    const result = tmp.dirSync(tmpOptions)
    request.trackCleanup(result.removeCallback)
    return result
  }

  unzip(source, destination) {
    return new Promise((resolve, reject) =>
      extract(source, { dir: destination }, error => (error ? reject(error) : resolve()))
    )
  }

  decompress(source, destination) {
    return decompress(source, destination, {
      filter: file => !file.path.endsWith('/'),
      plugins: [decompressTar(), decompressTargz(), decompressUnzip({ validateEntrySizes: false })]
    })
  }

  toSpec(request) {
    return request.casedSpec || EntitySpec.fromUrl(request.url)
  }

  getLatestVersion(versions) {
    if (!Array.isArray(versions)) return versions
    if (versions.length === 0) return null
    if (versions.length === 1) return versions[0]
    return versions
      .filter(v => !this.isPreReleaseVersion(v))
      .reduce((max, current) => (semver.gt(current, max) ? current : max), versions[0])
  }

  isPreReleaseVersion(version) {
    return semver.prerelease(version) !== null
  }

  link(request, name, spec) {
    request.linkResource(name, spec.toUrn())
  }

  addSelfLink(request, urn = null) {
    urn = urn || this.toSpec(request).toUrn()
    request.linkResource('self', urn)
  }

  addBasicToolLinks(request, spec) {
    request.linkResource('self', this.getUrnFor(request, spec))
    // create a new URN for the tool siblings. This should not have a version but should have the tool name
    const newSpec = new EntitySpec(spec.type, spec.provider, spec.namespace, spec.name, spec.revision, spec.tool)
    newSpec.tool = newSpec.tool || this.toolSpec.tool
    delete newSpec.toolVersion
    request.linkSiblings(newSpec.toUrn())
  }

  getUrnFor(request, spec = null) {
    spec = spec || this.toSpec(request)
    const newSpec = Object.assign(Object.create(spec), spec, this.toolSpec)
    return newSpec.toUrn()
  }

  linkAndQueue(request, name, spec = null) {
    spec = spec || this.toSpec(request)
    request.linkResource(name, spec.toUrn())
    request.queue(name, spec.toUrl(), request.getNextPolicy(name))
  }

  linkAndQueueTool(request, name, tool = name) {
    const spec = this.toSpec(request)
    const url = spec.toUrl()
    spec.tool = tool
    const urn = spec.toUrn()
    request.linkCollection(name, urn)
    request.queue(tool, url, request.getNextPolicy(name))
  }
}

module.exports = BaseHandler
