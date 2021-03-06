// Copyright (c) Microsoft Corporation and others. Licensed under the MIT license.
// SPDX-License-Identifier: MIT

const BaseHandler = require('../../lib/baseHandler')
const EntitySpec = require('../../lib/entitySpec')
const fs = require('fs')
const mavenCentral = require('../../lib/mavenCentral')
const sourceDiscovery = require('../../lib/sourceDiscovery')
const SourceSpec = require('../../lib/sourceSpec')
const parseString = require('xml2js').parseString
const { get } = require('lodash')

class MavenExtract extends BaseHandler {
  constructor(options, sourceFinder) {
    super(options)
    this.sourceFinder = sourceFinder
  }

  get schemaVersion() {
    return '1.1.2'
  }

  get toolSpec() {
    return { tool: 'clearlydefined', toolVersion: this.schemaVersion }
  }

  canHandle(request) {
    const spec = this.toSpec(request)
    return request.type === 'maven' && spec && spec.type === 'maven'
  }

  // Coming in here we expect the request.document to have id, location and metadata properties.
  // Do interesting processing...
  async handle(request) {
    if (this.isProcessing(request)) {
      // skip all the hard work if we are just traversing.
      const { spec } = super._process(request)
      this.addBasicToolLinks(request, spec)
      const manifest = await this._getManifest(request, request.document.location)
      await this._createDocument(request, spec, manifest, request.document.registryData)
      await BaseHandler.attachInterestinglyNamedFiles(request.document, request.document.location)
    }
    if (request.document.sourceInfo) {
      const sourceSpec = SourceSpec.fromObject(request.document.sourceInfo)
      this.linkAndQueue(request, 'source', sourceSpec.toEntitySpec())
    }
    return request
  }

  async _getManifest(request, location) {
    const pomContent = fs
      .readFileSync(location)
      .toString()
      .trim()
    const pom = await new Promise((resolve, reject) =>
      parseString(pomContent, (error, result) => (error ? reject(error) : resolve(result)))
    )

    // clean up some stuff we don't actually look at.
    delete pom.project.build
    delete pom.project.dependencies
    delete pom.project.dependencyManagement
    delete pom.project.modules
    delete pom.project.profiles

    if (pom && pom.project && pom.project.parent) {
      const parentManifest = await this._fetchParentPomManifest(request, pom)
      return this._mergePomInto(pom, parentManifest)
    } else return { summary: pom, poms: [pom] }
  }

  async _fetchParentPomManifest(request, pom) {
    const parent = pom.project.parent[0]
    const spec = new EntitySpec(
      'maven',
      'mavencentral',
      parent.groupId[0].trim(),
      parent.artifactId[0].trim(),
      parent.version[0].trim()
    )
    const file = this._createTempFile(request)
    const code = await mavenCentral.fetchPom(spec, file.name)
    if (code === 404) return { summary: {}, poms: [] }
    return await this._getManifest(request, file.name)
  }

  _mergePomInto(pom, manifest) {
    // TODO probably this should be a lot smarter...
    const summary = { project: Object.assign({}, manifest.summary.project, pom.project) }
    const poms = manifest.poms.slice(0)
    poms.unshift(pom)
    return {
      summary: summary,
      poms: poms
    }
  }

  _discoverCandidateSourceLocations(manifest) {
    const candidateUrls = []
    candidateUrls.push(get(manifest, 'project.scm.url'))
    return candidateUrls.filter(e => e)
  }

  async _discoverSource(spec, manifest, registryData) {
    const manifestCandidates = this._discoverCandidateSourceLocations(manifest)
    // TODO lookup source discovery in a set of services that have their own configuration
    const githubSource = await this.sourceFinder(spec.version, manifestCandidates, {
      githubToken: this.options.githubToken
    })
    if (githubSource) return githubSource
    // didn't find any source so make up a sources url to try if the registry thinks there is source
    if (!registryData.ec || !registryData.ec.includes(mavenCentral.sourceExtension)) return null
    const result = SourceSpec.fromObject(spec)
    result.type = 'sourcearchive'
    return result
  }

  async _createDocument(request, spec, manifest, registryData) {
    // setup the manifest to be the new document for the request
    request.document = { _metadata: request.document._metadata, manifest, registryData }
    // Add interesting info
    if (registryData.timestamp) request.document.releaseDate = new Date(registryData.timestamp).toISOString()
    // Add source info
    const sourceInfo = await this._discoverSource(spec, manifest, registryData)
    if (sourceInfo) request.document.sourceInfo = sourceInfo
  }
}

module.exports = (options, sourceFinder) => new MavenExtract(options, sourceFinder || sourceDiscovery)
