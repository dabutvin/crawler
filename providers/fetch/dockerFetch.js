// Copyright (c) Microsoft Corporation and others. Licensed under the MIT license.
// SPDX-License-Identifier: MIT

const AbstractFetch = require('./abstractFetch')
const { exec } = require('child_process')

class DockerFetch extends AbstractFetch {
  /*
  docker/dockerhub/-/node/1241241251351412
    curl -d '{"type":"docker", "url":"cd:/docker/dockerhub/fossology/fossology/3.4.0"}' -H "Content-Type: application/json" -H "X-token: secret" -X POST http://localhost:5000/requests
    curl -d '{"type":"docker", "url":"cd:/docker/dockerhub/-/node/11"}' -H "Content-Type: application/json" -H "X-token: secret" -X POST http://localhost:5000/requests
  */
  canHandle(request) {
    const spec = this.toSpec(request)
    return spec && spec.type === 'docker'
  }

  async handle(request) {
    const spec = this.toSpec(request)
    spec.revision = await this._getRevision(spec)
    request.url = spec.toUrl()
    const location = await this._getLocation(spec)
    const apk = await this._getApk(spec)
    const dpkg = await this._getDpkg(spec)
    if (!apk && !dpkg) return this.markSkip(request)
    request.document = { apk, dpkg, location }
    request.contentOrigin = 'origin'
    return request
  }

  async _getRevision(spec) {
    // docker pull spec.name + spec.version
    // need to pull before we can inspect

    // docker pull to resolve the sha256 as the absolute identifier
    // given fossology/fossology:3.4.0 => fossology/fossology@sha256:7f1919bbef199418d20db97107f5e69b60b4ae4984e4b53138dd3c506767a0b0
    // tern does not output this sha, but can accept this sha
    const imageName = this._getTagImageName(spec)
    await new Promise((resolve, reject) => {
      exec(`docker pull ${imageName}`, error => {
        if (error) return reject(error)
        resolve()
      })
    })
    return new Promise((resolve, reject) => {
      exec(`docker inspect --format='{{.RepoDigests}}' ${imageName}`, (error, stdout) => {
        if (error) return reject(error)
        //[fossology/fossology@sha256:7f1919bbef199418d20db97107f5e69b60b4ae4984e4b53138dd3c506767a0b0]
        resolve(stdout.match(/.*@sha256:([a-z0-9]+)\]/)[1])
      })
    }) //todo handle bad tags/names etc
  }

  async _getApk(spec) {
    // the name and versions are separated by hyphens
    // but the names and the versions can also have hyphens
    // dump the names and then dump name-versions so we can detect
    const imageName = this._getHashImageName(spec)
    const names = await new Promise((resolve, reject) => {
      exec(`docker run --entrypoint "apk" ${imageName} info`, (error, stdout) => {
        if (error) {
          if (error === 'SPECIFIC KNOWN ERROR') return resolve(null)
          //return reject(error)
          return resolve(null)
        }
        resolve(stdout.trim())
      })
    })
    if (!names) return null
    const namesAndVersions = await new Promise((resolve, reject) => {
      exec(`docker run --entrypoint "apk" ${imageName} info -v`, (error, stdout) => {
        if (error) return reject(error)
        resolve(stdout.trim())
      })
    })
    return { names, namesAndVersions }
  }

  _getDpkg(spec) {
    return new Promise((resolve, reject) => {
      exec(
        `docker run --entrypoint "dpkg" ${spec.namespace ? `${spec.namespace}/${spec.name}` : spec.name}@sha256:${
          spec.revision
        } --list | awk 'NR>5 {print $2 "___" $3}'`,
        (error, stdout) => {
          if (error) {
            if (error === 'SPECIFIC KNOWN ERROR') return resolve(null)
            //return reject(error)
            return resolve(null)
          }
          resolve(stdout.trim())
        }
      )
    })
  }

  _getLocation() {
    return new Promise(resolve => {
      // todo: mount the image to a directory so we can hash and harvest files etc
      resolve('')
    })
  }

  _getTagImageName(spec) {
    return spec.namespace ? `${spec.namespace}/${spec.name}:${spec.revision}` : `${spec.name}:${spec.revision}`
  }

  _getHashImageName(spec) {
    return spec.namespace
      ? `${spec.namespace}/${spec.name}@sha256:${spec.revision}`
      : `${spec.name}@sha256:${spec.revision}`
  }

  _getReport(spec, request) {
    const source = this.createTempDir(request).name
    const target = this.createTempDir(request).name
    const output = this.createTempFile(request).name
    const imageName = spec.namespace
      ? `${spec.namespace}/${spec.name}@${spec.revision}`
      : `${spec.name}@${spec.revision}`
    return new Promise((resolve, reject) => {
      exec(
        // maybe add the option to keep the dir so we can measure it etc
        // try to ditch the docker.sock stuff and see if we good
        `docker run --privileged -v /var/run/docker.sock:/var/run/docker.sock --mount type=bind,source=${source},target=${target} ternd report -j -i ${imageName} -f ${output}`,
        error => {
          if (error) return reject(error)
          resolve(output)
        }
      )
    })
  }
}

module.exports = options => new DockerFetch(options)

/*

startup steps

1. git clone https://github.com/vmware/tern.git
2. cd tern
3. git checkout -b v0.3.0 v0.3.0
4. docker build -t ternd .
5. docker run --entrypoint "npm"  clearlydefined/crawler:latest run start-contained

fetcher steps

1. generate sourceTempDir, targetTempDir, reportTempFile
2. docker run --privileged -v /var/run/docker.sock:/var/run/docker.sock --mount type=bind,source=$tempdir1,target=$tempdir2 ternd report -j -i <imageName>:<imageVersion> > $reportTempFile
3. harvest json output as content

*/

// docker run --privileged -v /var/run/docker.sock:/var/run/docker.sock --mount type=bind,source=/Users/dan/codes/temp/trytern/tern/workdir,target=/temp ternd report -j -i fossology/fossology:3.4.0 > output_fossology2.json

/////////////////////////////////////////////////

/*

$ docker run --entrypoint "dpkg" fossology/fossology:3.4.0 --get-selections
$ docker run --entrypoint "apk" node:6-alpine info



*/
