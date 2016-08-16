'use strict';

var browser = require('../util/browser');
var mat2 = require('gl-matrix').mat2;
var pixelsToTileUnits = require('../source/pixels_to_tile_units');

module.exports = function (painter, source, layer, coords) {
    if (painter.isOpaquePass) return;
    if (layer.paint['line-width'] <= 0) return;

    if (layer.paint['line-dasharray']) {
        drawDasharrayLines(painter, source, layer, coords);
    } else if (layer.paint['line-pattern']) {
        drawPatternLines(painter, source, layer, coords);
    } else {
        drawSolidLines(painter, source, layer, coords);
    }
};

function drawDasharrayLines(painter, source, layer, coords) {
    var gl = painter.gl;

    var dasharray = layer.paint['line-dasharray'];
    var posA = painter.lineAtlas.getDash(dasharray.from, layer.layout['line-cap'] === 'round');
    var posB = painter.lineAtlas.getDash(dasharray.to, layer.layout['line-cap'] === 'round');

    drawLines(painter, source, layer, coords, 'linesdfpattern', function (program) {
        gl.uniform1f(program.u_gapwidth, layer.paint['line-gap-width'] / 2);
        gl.uniform1f(program.u_linewidth, layer.paint['line-width'] / 2);
        gl.uniform1f(program.u_mix, dasharray.t);
        gl.uniform1f(program.u_offset, -layer.paint['line-offset']);
        gl.uniform1f(program.u_opacity, layer.paint['line-opacity']);
        gl.uniform1f(program.u_tex_y_a, posA.y);
        gl.uniform1f(program.u_tex_y_b, posB.y);
        gl.uniform4fv(program.u_color, layer.paint['line-color']);

        gl.uniform1i(program.u_image, 0);
        gl.activeTexture(gl.TEXTURE0);
        painter.lineAtlas.bind(gl);

    }, function(program, tile) {
        var widthA = posA.width * dasharray.fromScale;
        var widthB = posB.width * dasharray.toScale;
        var gamma = painter.lineAtlas.width / (Math.min(widthA, widthB) * 256 * browser.devicePixelRatio * 2);

        gl.uniform2fv(program.u_patternscale_a, [
            1 / pixelsToTileUnits(tile, widthA, painter.transform.tileZoom),
            -posA.height / 2
        ]);
        gl.uniform2fv(program.u_patternscale_b, [
            1 / pixelsToTileUnits(tile, widthB, painter.transform.tileZoom),
            -posB.height / 2
        ]);
        gl.uniform1f(program.u_sdfgamma, gamma);
    });
}

function drawPatternLines(painter, source, layer, coords) {
    var gl = painter.gl;
    var imagePosA = painter.spriteAtlas.getPosition(layer.paint['line-pattern'].from, true);
    var imagePosB = painter.spriteAtlas.getPosition(layer.paint['line-pattern'].to, true);
    if (!imagePosA || !imagePosB) return;

    drawLines(painter, source, layer, coords, 'linepattern', function(program) {
        gl.uniform1f(program.u_fade, layer.paint['line-pattern'].t);
        gl.uniform1f(program.u_gapwidth, layer.paint['line-gap-width'] / 2);
        gl.uniform1f(program.u_linewidth, layer.paint['line-width'] / 2);
        gl.uniform1f(program.u_offset, -layer.paint['line-offset']);
        gl.uniform1f(program.u_opacity, layer.paint['line-opacity']);
        gl.uniform2fv(program.u_pattern_br_a, imagePosA.br);
        gl.uniform2fv(program.u_pattern_br_b, imagePosB.br);
        gl.uniform2fv(program.u_pattern_tl_a, imagePosA.tl);
        gl.uniform2fv(program.u_pattern_tl_b, imagePosB.tl);

        gl.uniform1i(program.u_image, 0);
        gl.activeTexture(gl.TEXTURE0);

        painter.spriteAtlas.bind(gl, true);

    }, function(program, tile) {
        gl.uniform2fv(program.u_pattern_size_a, [
            pixelsToTileUnits(tile, imagePosA.size[0] * layer.paint['line-pattern'].fromScale, painter.transform.tileZoom),
            imagePosB.size[1]
        ]);
        gl.uniform2fv(program.u_pattern_size_b, [
            pixelsToTileUnits(tile, imagePosB.size[0] * layer.paint['line-pattern'].toScale, painter.transform.tileZoom),
            imagePosB.size[1]
        ]);
    });
}

function drawSolidLines(painter, source, layer, coords) {
    var gl = painter.gl;

    drawLines(painter, source, layer, coords, 'line', function onChange(program) {
        gl.uniform1f(program.u_gapwidth, layer.paint['line-gap-width'] / 2);
        gl.uniform1f(program.u_linewidth, layer.paint['line-width'] / 2);
        gl.uniform1f(program.u_offset, -layer.paint['line-offset']);
        gl.uniform1f(program.u_opacity, layer.paint['line-opacity']);
        gl.uniform4fv(program.u_color, layer.paint['line-color']);
    });
}

function drawLines(painter, source, layer, coords, programName, onProgramChange, onTileChange) {
    var gl = painter.gl;

    gl.enable(gl.STENCIL_TEST);
    painter.setDepthSublayer(0);
    painter.depthMask(false);

    var antialiasingMatrix = mat2.create();
    mat2.scale(antialiasingMatrix, antialiasingMatrix, [1, Math.cos(painter.transform._pitch)]);
    mat2.rotate(antialiasingMatrix, antialiasingMatrix, painter.transform.angle);

    // calculate how much longer the real world distance is at the top of the screen
    // than at the middle of the screen.
    var topedgelength = Math.sqrt(painter.transform.height * painter.transform.height / 4  * (1 + painter.transform.altitude * painter.transform.altitude));
    var extra = (topedgelength + (painter.transform.height / 2 * Math.tan(painter.transform._pitch))) / topedgelength - 1;

    function _onProgramChange(program) {
        gl.uniform1f(program.u_extra, extra);
        gl.uniform1f(program.u_antialiasing, 1 / browser.devicePixelRatio / 2);
        gl.uniform1f(program.u_blur, layer.paint['line-blur'] + 1 / browser.devicePixelRatio);
        gl.uniformMatrix2fv(program.u_antialiasingmatrix, false, antialiasingMatrix);
        onProgramChange(program);
    }

    for (var j = 0; j < coords.length; j++) {
        var coord = coords[j];
        var tile = source.getTile(coord);
        var bucket = tile.getBucket(layer);
        if (!bucket) return;
        var groups = bucket.bufferGroups.line;
        if (!groups) return;

        var programOptions = bucket.paintAttributes.line[layer.id];
        var program = painter.useProgram(
            programName,
            programOptions.defines,
            programOptions.vertexPragmas,
            programOptions.fragmentPragmas,
            _onProgramChange
        );

        var posMatrix = painter.translatePosMatrix(coord.posMatrix, tile, layer.paint['line-translate'], layer.paint['line-translate-anchor']);
        gl.uniformMatrix4fv(program.u_matrix, false, posMatrix);
        gl.uniform1f(program.u_ratio, 1 / pixelsToTileUnits(tile, 1, painter.transform.zoom));
        painter.enableTileClippingMask(coord);
        bucket.setUniforms(gl, 'line', program, layer, {zoom: painter.transform.zoom});

        if (onTileChange) onTileChange(program, tile);

        for (var i = 0; i < groups.length; i++) {
            var group = groups[i];
            group.vaos[layer.id].bind(gl, program, group.layoutVertexBuffer, group.elementBuffer, group.paintVertexBuffers[layer.id]);
            gl.drawElements(gl.TRIANGLES, group.elementBuffer.length * 3, gl.UNSIGNED_SHORT, 0);
        }
    }

}
