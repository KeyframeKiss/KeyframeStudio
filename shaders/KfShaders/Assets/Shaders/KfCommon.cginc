// Shared bits for Keyframe Studio's image effects (Unity 5.6, applied in OnRenderImage on Studio's camera).
#ifndef KF_COMMON
#define KF_COMMON
#include "UnityCG.cginc"

sampler2D _MainTex;
float4 _MainTex_TexelSize;

struct v2f
{
    float4 pos : SV_POSITION;
    float2 uv : TEXCOORD0;
    float2 uvDepth : TEXCOORD1; // the depth texture isn't flipped when the source is (D3D + MSAA)
};

v2f vert(appdata_img v)
{
    v2f o;
    o.pos = UnityObjectToClipPos(v.vertex);
    o.uv = v.texcoord.xy;
    o.uvDepth = v.texcoord.xy;
#if UNITY_UV_STARTS_AT_TOP
    if (_MainTex_TexelSize.y < 0) o.uvDepth.y = 1 - o.uvDepth.y;
#endif
    return o;
}

float Luma(float3 c) { return dot(c, float3(0.2126, 0.7152, 0.0722)); }

#endif
