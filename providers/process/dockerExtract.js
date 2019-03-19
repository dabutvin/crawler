// Copyright (c) Microsoft Corporation and others. Licensed under the MIT license.
// SPDX-License-Identifier: MIT

const Request = require('ghcrawler').request
const AbstractClearlyDefinedProcessor = require('./abstractClearlyDefinedProcessor')
const { merge } = require('lodash')

class DockerExtract extends AbstractClearlyDefinedProcessor {
  get toolVersion() {
    return '1.0.0'
  }

  get toolName() {
    return 'docker'
  }

  canHandle(request) {
    return request.type === 'docker'
  }

  async handle(request) {
    super.handle(request)
    const apk = request.document.apk
    const dpkg = request.document.dpkg
    request.document = merge(this.clone(request.document), { apk, dpkg })
    this._queueDpkgs(request.document)
    this._queueApks(request.document)
    return request
  }

  _queueDpkgs(document) {
    if (!document.dpkg) return
    const dpkgList = document.dpkg.split('\n')
    for (let dpkg of dpkgList) {
      let [name, version] = dpkg.split('___')
      let url = `cd:/dpkg/dpkg/-/${name}/${version}`
      this.addEmbeddedComponent(document, url)
      let request = new Request('dpkg', url)
      //request.crawler.queue('dpkg', url,)
    }
  }

  _queueApks(document) {
    if (!document.apk) return
    const apkNameList = document.apk.names.split('\n')
    const apkNameAndVersionList = document.apk.namesAndVersions.split('\n')
    for (let i = 0; i < apkNameList.length; i++) {
      let name = apkNameList[i]
      let version = apkNameAndVersionList[i].replace(`${name}-`, '')
      let url = `cd:/apk/apk/-/${name}/${version}`
      this.addEmbeddedComponent(document, url)
      let request = new Request('apk', url)
      //request.crawler.queue('apk', url,)
    }
  }
}

module.exports = options => new DockerExtract(options)
