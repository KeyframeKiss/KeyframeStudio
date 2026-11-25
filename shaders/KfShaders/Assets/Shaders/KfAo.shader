// Ambient occlusion: soft shade where things meet (under the chin, between fingers, where a body meets the floor).
// From the depth only: each pixel looks around itself within a radius in metres for surfaces that close it in.
// Worked out at half size, blurred without crossing edges, then multiplied into the picture in a shade colour.
Shader "Hidden/KeyframeStudio/Ao"
{
    Properties
    {
        _MainTex ("", 2D) = "white" {}
        _KfAoTex ("", 2D) = "white" {}
    }
    CGINCLUDE
    #include "KfCommon.cginc"

    sampler2D_float _CameraDepthTexture;
    sampler2D _KfAoTex;
    float4 _KfAo;      // x intensity, y radius (m), z distance fade (m, 0 = none), w contrast (1 = as is)
    float4 _KfAoProj;  // x 1 / P[0,0], y 1 / P[1,1], z depth beyond which nothing is shaded (the sky), w unused
    float4 _KfAoColor; // rgb: the colour of the shade (black = plain darkening)
    float4 _KfAoDir;   // xy: blur direction in texels

    float Depth(float2 uv) { return LinearEyeDepth(SAMPLE_DEPTH_TEXTURE(_CameraDepthTexture, uv)); }
    float3 ViewPos(float2 uv) { float d = Depth(uv); return float3((uv * 2 - 1) * _KfAoProj.xy * d, d); }
    float Hash(float2 p) { return frac(sin(dot(p, float2(12.9898, 78.233))) * 43758.5453); }

    // 0: how open each pixel is (r), and its depth (g) for the blur
    float4 fragAo(v2f i) : SV_Target
    {
        float2 uv = i.uvDepth;
        float3 p = ViewPos(uv);
        if (p.z > _KfAoProj.z) return float4(1, p.z, 0, 1);
        float3 n = normalize(cross(ddy(p), ddx(p)));
        if (dot(n, p) > 0) n = -n; // the side facing the camera
        float2 ruv = _KfAo.y / (2 * p.z * _KfAoProj.xy);
        float ang = Hash(i.uv * _ScreenParams.xy) * 6.2831853;
        float occ = 0;
        const int N = 12;
        for (int k = 0; k < N; k++)
        {
            float t = (k + 0.5) / N;
            float a = ang + k * 2.39996323; // golden angle: an even spiral
            float2 o = float2(cos(a), sin(a)) * sqrt(t) * ruv;
            float3 v = ViewPos(uv + o) - p;
            float l = length(v);
            float range = 1 - smoothstep(0.75, 1.25, l / _KfAo.y);
            occ += max(0, dot(v, n) / max(l, 1e-4) - 0.12) * range;
        }
        float ao = saturate(1 - _KfAo.x * occ / N * 1.6);
        ao = pow(ao, _KfAo.w);
        if (_KfAo.z > 0) ao = lerp(ao, 1, saturate(p.z / _KfAo.z));
        return float4(ao, p.z, 0, 1);
    }

    // 1: blur along one direction, not across depth edges
    float4 fragBlur(v2f i) : SV_Target
    {
        float2 d = _MainTex_TexelSize.xy * _KfAoDir.xy;
        float4 c0 = tex2D(_MainTex, i.uv);
        float sum = c0.r, wsum = 1;
        for (int k = 1; k <= 4; k++)
        {
            float4 a = tex2D(_MainTex, i.uv + d * k);
            float4 b = tex2D(_MainTex, i.uv - d * k);
            float g = exp(-k * k / 8.0);
            float wa = g * saturate(1 - abs(a.g - c0.g) / (0.04 * c0.g + 0.01));
            float wb = g * saturate(1 - abs(b.g - c0.g) / (0.04 * c0.g + 0.01));
            sum += a.r * wa + b.r * wb;
            wsum += wa + wb;
        }
        return float4(sum / wsum, c0.g, 0, 1);
    }

    // 2: onto the picture
    fixed4 fragComp(v2f i) : SV_Target
    {
        fixed4 src = tex2D(_MainTex, i.uv);
        float ao = tex2D(_KfAoTex, i.uv).r;
        return fixed4(src.rgb * lerp(_KfAoColor.rgb, 1, ao), src.a);
    }
    ENDCG

    SubShader
    {
        ZTest Always Cull Off ZWrite Off
        Pass { CGPROGRAM
            #pragma vertex vert
            #pragma fragment fragAo
            #pragma target 3.0
            ENDCG }
        Pass { CGPROGRAM
            #pragma vertex vert
            #pragma fragment fragBlur
            #pragma target 3.0
            ENDCG }
        Pass { CGPROGRAM
            #pragma vertex vert
            #pragma fragment fragComp
            #pragma target 3.0
            ENDCG }
    }
    Fallback Off
}
